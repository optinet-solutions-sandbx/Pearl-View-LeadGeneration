require('dotenv').config();

const express = require('express');
const { sendMessage, sendLeadNotification: sendMetaLeadNotification, verifyWebhook, extractIncomingMessage } = require('./whatsapp');
const { sendLeadNotification: sendGreenLeadNotification, getInstanceState } = require('./greenapi');
const { runExtraction, buildOAuthClient, unlabelMessages, applyLabelToMatching } = require('./email-extractor');
const { getLeadsContext } = require('./airtable');
const { generateReply } = require('./ai');
const { sendInvoiceForLead } = require('./invoice');
const { createRebooking, getBookInfo } = require('./booking');
const { bookingPageHtml } = require('./booking-page');
const { TZ } = require('./config');

const app = express();
app.use(express.json());

// Allow requests from the Vercel dashboard
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'pearl-view-whatsapp' });
});

app.get('/health/transport', async (req, res) => {
  const greenState = await getInstanceState();
  const greenHealthy = greenState === 'authorized';
  res.json({
    transport: process.env.NOTIF_TRANSPORT || 'green',
    greenApi: { state: greenState, healthy: greenHealthy },
    metaConfigured: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
  });
});

// ─── Meta webhook verification (GET) ─────────────────────────────────────────
// Meta sends a GET to verify the webhook URL when you click "Verify and Save"
app.get('/webhook', (req, res) => {
  const challenge = verifyWebhook(req.query);
  if (challenge) {
    console.log('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }
  console.warn('Webhook verification failed — check WHATSAPP_VERIFY_TOKEN');
  res.sendStatus(403);
});

// ─── Incoming WhatsApp messages (POST) ───────────────────────────────────────
// Meta sends a POST for every incoming message
app.post('/webhook', async (req, res) => {
  // Always respond 200 immediately so Meta doesn't retry
  res.sendStatus(200);

  // Log delivery status callbacks (sent / delivered / read / failed)
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses) {
      value.statuses.forEach(s => {
        const errInfo = s.errors ? ` errors=${JSON.stringify(s.errors)}` : '';
        console.log(`[STATUS] msg=${s.id} to=${s.recipient_id} status=${s.status}${errInfo}`);
      });
    }
  } catch (e) {
    console.error('Error parsing status webhook:', e.message);
  }

  const incoming = extractIncomingMessage(req.body);
  if (!incoming) return; // not a text message, ignore

  console.log(`Incoming message from ${incoming.from}: ${incoming.text}`);

  try {
    const context = await getLeadsContext();
    const reply = await generateReply(incoming.text, context);
    await sendMessage(incoming.from, reply);
    console.log(`Replied to ${incoming.from}`);
  } catch (err) {
    console.error('Error handling incoming message:', err.message);
  }
});

// ─── New lead notification ────────────────────────────────────────────────────
// Called by the Pearl View frontend (useLeads.js) when a new lead is added
app.post('/notify-lead', async (req, res) => {
  const { name, phone, email, subject, leadSource } = req.body;

  if (!name && !phone) {
    return res.status(400).json({ error: 'Missing lead data' });
  }

  const recipients = (process.env.OWNER_PHONE || '')
    .split(',')
    .map(p => p.replace(/[^\d]/g, ''))
    .filter(Boolean);

  if (recipients.length === 0) {
    console.warn('OWNER_PHONE not set — skipping notification');
    return res.status(200).json({ skipped: true });
  }

  const now = new Date().toLocaleString('en-AU', {
    timeZone: TZ,
    dateStyle: 'short',
    timeStyle: 'short',
  });

  // Pre-flight: check Green-API instance state. If unhealthy, fail fast
  // with a loud alert so the operator can re-authorize.
  const state = await getInstanceState();
  if (state !== 'authorized') {
    console.error(`[ALERT] 🚨 Green-API instance NOT authorized (state=${state}). Lead notification BLOCKED. Re-scan QR code in console.green-api.com to restore.`);
    return res.status(503).json({
      error: 'Green-API instance not authorized',
      state,
      action: 'Re-scan the QR code at console.green-api.com to re-authorize the sender WhatsApp.',
      lead: { name, phone, email, subject, leadSource },
    });
  }

  const sendOne = async (to, lead) => {
    try {
      const r = await sendGreenLeadNotification(to, lead);
      return { transport: 'green', result: r };
    } catch (err) {
      const errMsg = err.response?.data?.errorMessage || err.response?.data || err.message;
      console.error(`[ALERT] 🚨 Green-API send FAILED for ${to}: ${JSON.stringify(errMsg)}`);
      throw err;
    }
  };

  const results = await Promise.allSettled(
    recipients.map(to => sendOne(to, { name, phone, email, subject, source: leadSource, time: now }))
  );

  const successes = [];
  const failures = [];
  results.forEach((r, i) => {
    const to = recipients[i];
    if (r.status === 'fulfilled') {
      const via = r.value?.transport || 'unknown';
      successes.push({ to, via });
      console.log(`New lead notification sent to ${to} via ${via}`);
    } else {
      failures.push({ to, error: r.reason?.response?.data || r.reason?.message });
      console.error(`[RAILGUARD] BOTH transports failed for ${to}:`, r.reason?.response?.data || r.reason?.message);
    }
  });

  if (successes.length === 0) {
    return res.status(500).json({ error: 'All recipients failed', failures });
  }
  res.json({ success: true, sent: successes, failed: failures });
});

// ─── Send invoice ───────────────────────────────────────────────────────────
// Called by the dashboard when a job is marked Done (Review & Send modal).
// body: { leadId, to, clientName, project, description, amount, dueDate, notes, test }
//   test=true → emails a full invoice stamped #TEST, no sequence number consumed,
//   lead NOT marked sent. Use to validate the live flow safely.
app.post('/send-invoice', async (req, res) => {
  try {
    const out = await sendInvoiceForLead(req.body || {});
    console.log(`[send-invoice] ${out.test ? 'TEST ' : ''}sent #${out.invoiceNumber} to ${out.to} ($${out.amount})`);
    res.json(out);
  } catch (err) {
    const code = err.code === 'ALREADY_SENT' ? 409 : (err.code === 'NO_EMAIL' ? 400 : 500);
    console.error(`[send-invoice] FAILED (${err.code || 'ERR'}):`, err.message);
    res.status(code).json({ error: err.message, code: err.code || 'ERR' });
  }
});

// ─── Client rebooking ────────────────────────────────────────────────────────
// Public booking page (served here, off the dashboard domain). GET /book?t=<token>
app.get('/book', (req, res) => {
  res.type('html').send(bookingPageHtml());
});

// Booking page bootstrap: resolve a signed token → client name, suggested date,
// and already-booked dates to block. GET /book-info?t=<token>
app.get('/book-info', async (req, res) => {
  try {
    const out = await getBookInfo(req.query.t);
    res.json(out);
  } catch (err) {
    const code = err.code === 'BAD_TOKEN' ? 401 : 500;
    console.error(`[book-info] FAILED (${err.code || 'ERR'}):`, err.message);
    res.status(code).json({ error: err.message, code: err.code || 'ERR' });
  }
});

// Client confirms a date. body: { t (signed token), date (YYYY-MM-DD), time?, service? }
//   → creates a Bookings row (shows on dashboard) + emails the client an .ics.
app.post('/book', async (req, res) => {
  try {
    const out = await createRebooking(req.body || {});
    console.log(`[book] booked ${out.clientName} on ${out.date} ${out.time} (invite=${out.inviteSent})`);
    res.json(out);
  } catch (err) {
    const code = err.code === 'BAD_TOKEN' ? 401 : (err.code === 'BAD_REQUEST' ? 400 : 500);
    console.error(`[book] FAILED (${err.code || 'ERR'}):`, err.message);
    res.status(code).json({ error: err.message, code: err.code || 'ERR' });
  }
});

// ─── Gmail OAuth: start flow ─────────────────────────────────────────────────
// Visit /oauth/start?account=form (from service@pearlview.com.au)
// or /oauth/start?account=call (from pearlviewwindowcleaning@gmail.com)
app.get('/oauth/start', (req, res) => {
  const account = req.query.account;
  if (!['form', 'call'].includes(account)) {
    return res.status(400).send('Use ?account=form or ?account=call');
  }
  try {
    const oauth2 = buildOAuthClient();
    const url = oauth2.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/gmail.send',
      ],
      state: account,
    });
    res.redirect(url);
  } catch (err) {
    res.status(500).send('OAuth init failed: ' + err.message);
  }
});

// ─── Gmail OAuth: callback ───────────────────────────────────────────────────
app.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state');
  try {
    const oauth2 = buildOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      return res.status(500).send('No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and retry.');
    }
    const envVar = state === 'form' ? 'GMAIL_FORM_REFRESH_TOKEN' : 'GMAIL_CALL_REFRESH_TOKEN';
    console.log(`[OAUTH] Captured refresh token for ${state}. Add this Cloud Run env var: ${envVar}=${tokens.refresh_token}`);
    res.send(`
      <html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px">
        <h2>✅ Authorization successful</h2>
        <p>Add this as a Cloud Run environment variable:</p>
        <pre style="background:#f4f4f4;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-all">${envVar}=${tokens.refresh_token}</pre>
        <p>Then trigger extraction by hitting <code>POST /extract-emails</code>.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('OAuth callback failed: ' + err.message);
  }
});

// ─── Admin: unlabel messages so they re-extract ──────────────────────────────
app.post('/admin/unlabel', async (req, res) => {
  const account = req.query.account || req.body?.account;
  const label = req.query.label || req.body?.label;
  if (!account || !label) return res.status(400).json({ error: 'Need ?account=form|call&label=<labelName>' });
  try {
    const result = await unlabelMessages(account, label);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/admin/search', async (req, res) => {
  const account = req.query.account;
  const q = req.query.q;
  if (!account || !q) return res.status(400).json({ error: 'Need ?account=form|call&q=<gmail-query>' });
  try {
    const { google } = require('googleapis');
    const refreshToken = account === 'form' ? process.env.GMAIL_FORM_REFRESH_TOKEN : process.env.GMAIL_CALL_REFRESH_TOKEN;
    const oauth2 = buildOAuthClient();
    oauth2.setCredentials({ refresh_token: refreshToken });
    const gmail = google.gmail({ version: 'v1', auth: oauth2 });
    const list = await gmail.users.messages.list({ userId: 'me', q, maxResults: 20 });
    const ids = (list.data.messages || []).map(m => m.id);
    const summaries = [];
    for (const id of ids.slice(0, 5)) {
      const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] });
      const headers = msg.data.payload?.headers || [];
      const get = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
      summaries.push({ id, labels: msg.data.labelIds, subject: get('Subject'), from: get('From'), date: get('Date') });
    }
    res.json({ totalMatched: ids.length, ids, samples: summaries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/relabel', async (req, res) => {
  const account = req.query.account || req.body?.account;
  const label = req.query.label || req.body?.label;
  const query = req.query.q || req.body?.q;
  if (!account || !label || !query) return res.status(400).json({ error: 'Need ?account=form|call&label=<labelName>&q=<gmail-query>' });
  try {
    const result = await applyLabelToMatching(account, label, query);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Extract emails (called by Cloud Scheduler cron, or manually) ────────────
app.post('/extract-emails', async (req, res) => {
  try {
    // notify defaults to true (cron behaviour). Pass ?notify=false for a silent
    // backfill so old/missed leads don't blast WhatsApp alerts to the owner.
    const notify = !(req.query.notify === 'false' || req.body?.notify === false);
    const result = await runExtraction({ notify });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[ALERT] 🚨 Email extraction failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Pearl View WhatsApp service running on port ${PORT}`);
});
