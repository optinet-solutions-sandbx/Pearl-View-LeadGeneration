/**
 * followup.js — the quote follow-up job. Cloud Scheduler calls
 * POST /run-followups every 15 min → runFollowups(). Every decision comes from
 * followup-core.js (pure, unit-tested); this file only does I/O, and all I/O
 * goes through `deps` so followup.test.js can run it against fakes.
 */
const { google } = require('googleapis');
const sb = require('./sb');
const core = require('./followup-core');
const { BUSINESS, DASHBOARD_URL, TZ } = require('./config');

const BATCH = 25;     // leads per run
const LEASE_MIN = 10; // claim lease — a crashed run frees its leads after this

function gmailFor(refreshToken) {
  // Lazy require: email-extractor is the whole ingestion module; load only to send/search.
  const { buildOAuthClient } = require('./email-extractor');
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

// Same sender as invoices: the dedicated SEND token, From/Reply-To = BUSINESS.email.
async function sendEmail({ to, subject, text, html }) {
  const gmail = gmailFor(process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN);
  const mime = core.buildFollowupMime({ fromName: BUSINESS.name, fromEmail: BUSINESS.email, to, subject, text, html });
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: core.b64url(mime) } });
  return r.data.id;
}

// Replies go to Reply-To = BUSINESS.email (service@…), which is the FORM inbox
// the email extractor already reads — so search it with the form token.
async function hasReplied(email, since) {
  const token = process.env.GMAIL_FORM_REFRESH_TOKEN;
  if (!token || !email || !since) return false;
  const after = Math.floor(new Date(since).getTime() / 1000);
  const r = await gmailFor(token).users.messages.list({
    userId: 'me', q: `from:${email} after:${after} -in:sent -in:chats`, maxResults: 1,
  });
  return (r.data.messages || []).length > 0;
}

async function alertOwner(lead) {
  const { sendText, getInstanceState } = require('./greenapi');
  const recipients = (process.env.OWNER_PHONE || '').split(',').map(p => p.replace(/[^\d]/g, '')).filter(Boolean);
  if (!recipients.length) return;
  const state = await getInstanceState();
  if (state !== 'authorized') {
    console.error(`[ALERT] 🚨 Green-API not authorized (state=${state}) — follow-up reply alert NOT sent for ${lead.id}`);
    return;
  }
  const msg = core.replyAlertText(lead, BUSINESS.email, DASHBOARD_URL);
  await Promise.allSettled(recipients.map(to => sendText(to, msg)));
}

const realDeps = {
  getSettings: sb.getFollowupSettings,
  fetchDue: sb.fetchDueFollowups,
  claim: sb.claimFollowup,
  update: sb.updateActiveFollowup,
  log: sb.insertFollowupLog,
  sendEmail,
  hasReplied,
  alertOwner,
};

async function runFollowups({ dry = false, now = new Date(), deps = realDeps } = {}) {
  if (deps === realDeps && !sb.USE_SUPABASE) return { skipped: 'supabase_off' };
  const settings = await deps.getSettings();
  if (!settings) return { skipped: 'not_set_up' };
  const inWindow = core.inSendWindow(now, TZ, settings.window_start_hour, settings.window_end_hour);
  // A dry run always reports the plan, so it can be checked before switching on.
  if (!dry && !settings.enabled) return { skipped: 'disabled' };
  if (!dry && !inWindow) return { skipped: 'outside_window' };

  const leads = await deps.fetchDue({ nowIso: now.toISOString(), testOnly: !!settings.test_mode, limit: BATCH });
  const out = {
    dry, enabled: !!settings.enabled, testMode: !!settings.test_mode, inWindow, due: leads.length,
    sent: 0, held: 0, skipped: 0, replied: 0, completed: 0, errors: 0, actions: [],
  };

  for (const lead of leads) {
    const action = core.planAction(lead, settings, BUSINESS.name);
    out.actions.push({ id: lead.id, name: lead.client_name, step: lead.followup_step, type: action.type, ...(action.to ? { to: action.to } : {}) });
    if (dry) continue;
    if (action.type === 'hold') { out.held++; continue; }

    try {
      if (!(await deps.claim(lead.id, lead.followup_step, now, LEASE_MIN))) continue;

      if (action.type === 'complete') {
        await deps.update(lead.id, { followup_status: 'completed', followup_next_at: null });
        out.completed++;
        continue;
      }
      if (action.type === 'no_email') {
        await deps.update(lead.id, { followup_status: 'no_email', followup_next_at: null });
        continue;
      }
      if (action.type === 'skip') {
        await deps.update(lead.id, core.afterStep(settings, action.stepIndex, now, { sent: false }));
        out.skipped++;
        continue;
      }

      // send — but never after the customer has already written back
      if (await deps.hasReplied(core.cleanEmail(lead.email), lead.quote_sent_at)) {
        await deps.update(lead.id, { followup_status: 'replied', followup_stop_reason: 'replied', followup_next_at: null });
        out.replied++;
        await deps.alertOwner(lead).catch(e => console.error('[followups] owner alert failed:', e.message));
        continue;
      }

      const step = action.stepIndex + 1;
      let messageId;
      try {
        messageId = await deps.sendEmail({ to: action.to, subject: action.subject, text: action.text, html: core.htmlFromText(action.text) });
      } catch (err) {
        const msg = String(err.message || err).slice(0, 500);
        console.error(`[ALERT] 🚨 [followups] send failed for ${lead.id} (FU${step}): ${msg}`);
        await deps.log({ lead_id: lead.id, step, to_email: action.to, test_mode: action.test, error: msg });
        await deps.update(lead.id, core.afterFailure(lead, now));
        out.errors++;
        continue;
      }
      await deps.log({ lead_id: lead.id, step, to_email: action.to, test_mode: action.test, gmail_message_id: messageId });
      await deps.update(lead.id, core.afterStep(settings, action.stepIndex, now, { sent: true }));
      out.sent++;
      console.log(`[followups] FU${step} sent to ${action.to} for ${lead.client_name} (${lead.id})${action.test ? ' [TEST]' : ''}`);
    } catch (err) {
      // e.g. Gmail/DB outage during the reply check — the lease expires and a later run retries.
      console.error(`[ALERT] 🚨 [followups] lead ${lead.id} failed: ${err.message}`);
      out.errors++;
    }
  }
  return out;
}

module.exports = { runFollowups };
