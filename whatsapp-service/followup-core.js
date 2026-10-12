/**
 * followup-core.js — pure logic for the quote follow-up sequence (no I/O).
 * Deterministic + unit-tested (followup-core.test.js). followup.js does the
 * DB / Gmail / WhatsApp side effects. The frontend mirrors firstName /
 * formatMoney / renderTemplate / isTestLead in src/utils/followupTemplate.js —
 * execution/test_followup_template.mjs keeps the two in sync.
 */

const FOLLOWUP_HEADER = 'X-PearlView-Kind';
const FOLLOWUP_KIND = 'followup';
const REFUSAL_CODE = 'no_response';

// ─── Email + template helpers ────────────────────────────────────────────────
const INVISIBLE = [0x200B, 0x200C, 0x200D, 0xFEFF, 0xA0];
const EMAIL_TOKEN = /[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+/;
const NO_NAME = /^(unknown( caller)?|—|-|n\/a)?$/i;

// Strip invisible chars, then take the first email-shaped token. Anything after
// whitespace (incl. CR/LF) is dropped, so a stored value can't inject headers.
function cleanEmail(raw) {
  const zapped = [...String(raw || '')].filter(c => !INVISIBLE.includes(c.codePointAt(0))).join('');
  const m = zapped.match(EMAIL_TOKEN);
  return m ? m[0] : '';
}

function firstName(clientName) {
  const n = String(clientName || '').trim();
  return NO_NAME.test(n) ? 'there' : n.split(/\s+/)[0];
}

function formatMoney(n) {
  const v = Number(n);
  if (!(v > 0)) return '';
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) =>
    (Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key] ?? '') : m));
}

function buildContext(lead, settings, fallbackCompany) {
  const company = String(settings.company_name || '').trim() || fallbackCompany;
  return {
    first_name: firstName(lead.client_name),
    client_name: String(lead.client_name || '').trim(),
    company,
    sender: String(settings.sender_name || '').trim() || company,
    quote_amount: formatMoney(lead.quote_amount),
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function htmlFromText(text) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const body = paras.map(p => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return '<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;'
    + `font-size:15px;line-height:1.55;color:#1f2937">${body}</body></html>`;
}

function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 for non-ASCII; CR/LF collapsed first so a value can't start a new header.
function encodeHeader(str) {
  const s = String(str || '').replace(/[\r\n]+/g, ' ');
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

function buildFollowupMime({ fromName, fromEmail, to, subject, text, html }) {
  const alt = 'pv_followup_alt_0001';
  const from = `${encodeHeader(fromName)} <${cleanEmail(fromEmail)}>`;
  return [
    `From: ${from}`,
    `To: ${cleanEmail(to)}`,
    `Reply-To: ${from}`,
    `Subject: ${encodeHeader(subject)}`,
    `${FOLLOWUP_HEADER}: ${FOLLOWUP_KIND}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(text || ''), 'utf-8').toString('base64'),
    '',
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(html || ''), 'utf-8').toString('base64'),
    '',
    `--${alt}--`,
  ].join('\r\n');
}

// Used by email-extractor.js so our own follow-ups are never ingested as leads.
function isFollowupMessage(headers) {
  return (headers || []).some(h =>
    String(h.name || '').toLowerCase() === FOLLOWUP_HEADER.toLowerCase()
    && String(h.value || '').trim().toLowerCase() === FOLLOWUP_KIND);
}

function replyAlertText(lead, inbox, dashboardUrl) {
  const who = String(lead.client_name || '').trim() || 'A customer';
  return [
    '*💬 Quote follow-up reply*',
    '',
    `${who} (${cleanEmail(lead.email) || 'no email'}) replied after a quote follow-up.`,
    `Check the ${inbox} inbox and reach out personally — automatic follow-ups for this lead have stopped.`,
    '',
    '👉 Open in app:',
    dashboardUrl,
  ].join('\n');
}

// ─── Scheduling decisions ────────────────────────────────────────────────────
const DEFAULT_DELAY_HOURS = [48, 72, 120];
const MAX_FAILS = 3;
const HOUR_MS = 3600 * 1000;

function localHour(now, tz) {
  const part = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', hourCycle: 'h23', timeZone: tz })
    .formatToParts(now).find(p => p.type === 'hour');
  return parseInt(part.value, 10) % 24;
}

function inSendWindow(now, tz, startHour, endHour) {
  const start = Number.isInteger(startHour) ? startHour : 8;
  const end = Number.isInteger(endHour) ? endHour : 18;
  const h = localHour(now, tz);
  return h >= start && h < end;
}

function isTestLead(name) {
  return /^\s*test\b/i.test(String(name || ''));
}

function delayHours(steps, i) {
  const raw = steps?.[i]?.delay_hours;
  const d = typeof raw === 'number' ? raw : parseFloat(raw);
  return Number.isFinite(d) && d >= 0 && d <= 8760 ? d : (DEFAULT_DELAY_HOURS[i] ?? 72);
}

// What to do with ONE due lead. `followup_step` = number of steps already
// processed, i.e. the index of the step to handle now.
function planAction(lead, settings, fallbackCompany) {
  const steps = Array.isArray(settings.steps) ? settings.steps : [];
  const i = Number(lead.followup_step) || 0;
  if (i >= steps.length) return { type: 'complete' };

  const test = !!settings.test_mode;
  if (test && !isTestLead(lead.client_name)) return { type: 'hold', reason: 'test_mode' };

  const step = steps[i] || {};
  if (step.enabled === false) return { type: 'skip', stepIndex: i };

  const realTo = cleanEmail(lead.email);
  if (!realTo) return { type: 'no_email' };

  let to = realTo;
  if (test) {
    to = cleanEmail(settings.test_email);
    if (!to) return { type: 'hold', reason: 'no_test_email' }; // never fall through to the customer
  }

  const ctx = buildContext(lead, settings, fallbackCompany);
  const subject = renderTemplate(step.subject, ctx).trim();
  const text = renderTemplate(step.body, ctx).trim();
  if (!subject || !text) return { type: 'skip', stepIndex: i }; // never send an empty email

  return { type: 'send', stepIndex: i, to, realTo, test, subject: test ? `[TEST → ${realTo}] ${subject}` : subject, text };
}

// Column patch after step `stepIndex` was processed (sent or skipped). A
// disabled step's wait still elapses, so later steps keep their timing.
function afterStep(settings, stepIndex, now, { sent }) {
  const steps = Array.isArray(settings.steps) ? settings.steps : [];
  const next = stepIndex + 1;
  if (next < steps.length) {
    return {
      followup_step: next,
      followup_next_at: new Date(now.getTime() + delayHours(steps, next) * HOUR_MS).toISOString(),
      followup_fail_count: 0,
    };
  }
  const done = { followup_step: next, followup_status: 'completed', followup_next_at: null, followup_fail_count: 0 };
  // The final email tells the customer we're closing their inquiry — so we do.
  return sent ? { ...done, lead_status: 'Refused', refusal_reason: REFUSAL_CODE } : done;
}

function afterFailure(lead, now) {
  const fails = (Number(lead.followup_fail_count) || 0) + 1;
  if (fails >= MAX_FAILS) {
    return { followup_fail_count: fails, followup_status: 'error', followup_stop_reason: 'send_failed', followup_next_at: null };
  }
  return { followup_fail_count: fails, followup_next_at: new Date(now.getTime() + HOUR_MS).toISOString() };
}

// Gmail search for a customer reply since the quote went out. A missing/invalid
// quote date falls back to a 30-day window (never an unbounded search).
function replySearchQuery(email, sinceIso) {
  const ms = Date.parse(sinceIso);
  if (Number.isNaN(ms)) return `from:${email} newer_than:30d -in:sent -in:chats`;
  return `from:${email} after:${Math.floor(ms / 1000)} -in:sent -in:chats`;
}

module.exports = {
  FOLLOWUP_HEADER, FOLLOWUP_KIND, REFUSAL_CODE, DEFAULT_DELAY_HOURS, MAX_FAILS,
  cleanEmail, firstName, formatMoney, renderTemplate, buildContext,
  htmlFromText, b64url, buildFollowupMime, isFollowupMessage, replyAlertText,
  localHour, inSendWindow, isTestLead, delayHours, planAction, afterStep, afterFailure,
  replySearchQuery,
};
