const { google } = require('googleapis');
const axios = require('axios');
const sb = require('./sb');
const { BUSINESS, DASHBOARD_URL, TZ } = require('./config');
const { syncContactToList } = require('./mobilemessage');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const LEADS_TABLE_ID = process.env.AIRTABLE_TABLE_ID || 'tblS1keAU26CH08KJ';

// Gmail inboxes read for leads (identity carried by the refresh tokens; these
// are documentation). A second location points its OWN Gmail accounts here.
const FORM_GMAIL_USER = process.env.FORM_GMAIL_USER || 'service@pearlview.com.au';
const CALL_GMAIL_USER = process.env.CALL_GMAIL_USER || 'pearlviewwindowcleaning@gmail.com';

const FORM_LABEL_NAME = process.env.FORM_LABEL || 'Form Leads';
const CALL_LABEL_NAME = process.env.CALL_LABEL || 'Call Recordings';

// Gmail search that matches this location's website form emails. NSW default
// covers the Squarespace forms + the Pearl View site; a second location sets
// FORM_GMAIL_MATCH to its own sender(s)/subject(s).
const FORM_GMAIL_MATCH = process.env.FORM_GMAIL_MATCH
  || '(from:form-submission@squarespace.info) OR (from:pearlview.com.au) OR subject:(new message from Pearl View)';

// ─── OAuth helpers ───────────────────────────────────────────────────────────
function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET,
    process.env.GMAIL_OAUTH_REDIRECT_URI,
  );
}

function gmailClient(refreshToken) {
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

// ─── Parsers ─────────────────────────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return '';
  return raw.replace(/[*_~`]/g, '').replace(/\s+/g, '').trim();
}

function cleanText(raw) {
  if (!raw) return '';
  // Strip leading/trailing markdown markers (*bold*, _italic_), commas, and whitespace
  return raw.replace(/^[*_~\s]+|[*_~\s]+$/g, '').replace(/^[,;]\s*|\s*[,;]$/g, '').trim();
}

function pickFirstNonEmpty(matches) {
  for (const m of matches) {
    if (m && m.trim()) return m.trim();
  }
  return '';
}

function parseCrystalProForm(body) {
  // "Sent via form submission from Window Cleaning Services Gold Coast"
  // Fields: Name / Phone / Email / Message — use [ \t]* so newlines aren't swallowed
  // Strip leading * for "**Name:**" markdown bold style
  const name = cleanText(body.match(/\*?Name:\*?[ \t]*(.+)/i)?.[1] || '');
  const phone = normalizePhone(body.match(/\*?Phone:\*?[ \t]*(.+)/i)?.[1] || '');
  const email = cleanText(body.match(/\*?Email:\*?[ \t]*(.+)/i)?.[1] || '');
  const messageMatch = body.match(/\*?Message:\*?[ \t]*([\s\S]+?)(?:\n\s*Does this submission|\n\s*Manage Submissions|\n\s*$)/i);
  const message = cleanText(messageMatch?.[1] || '');
  return {
    name,
    phone,
    email,
    subject: message,
    source: 'website-crystalpro',
  };
}

function parsePearlViewForm(body, source = 'website-pearlview') {
  // Multiple "Name:" lines possible (empty header line + value line). Pick first non-empty.
  const nameMatches = [...body.matchAll(/\*?Name:\*?[ \t]*(.+)/gi)].map(m => cleanText(m[1])).filter(Boolean);
  const name = nameMatches[0] || '';
  const phone = normalizePhone(body.match(/\*?Phone:\*?[ \t]*(.+)/i)?.[1] || '');
  const email = cleanText(body.match(/\*?Email:\*?[ \t]*(.+)/i)?.[1] || '');
  const messageMatch = body.match(/\*?Message:\*?[ \t]*([\s\S]+?)(?:\n\s*---|\n\s*Date:|\n\s*$)/i);
  const message = cleanText(messageMatch?.[1] || '');
  return {
    name,
    phone,
    email,
    subject: message,
    source,
  };
}

function parseCallReport(body) {
  const time = body.match(/Time:\s*(.+)/i)?.[1]?.trim() || '';
  const caller = normalizePhone(body.match(/Caller:\s*(.+)/i)?.[1] || '');
  const called = normalizePhone(body.match(/Called:\s*(.+)/i)?.[1] || '');
  const lengthMatch = body.match(/Length:\s*(\d+)\s*second/i);
  const lengthSec = lengthMatch ? parseInt(lengthMatch[1], 10) : null;
  const duration = lengthSec != null
    ? `${Math.floor(lengthSec / 60)}m ${lengthSec % 60}s`
    : '';
  return {
    callerId: caller,
    phone: caller,
    callTime: time,
    callDuration: duration,
    calledLine: called,
    source: 'Phone Call',
  };
}

// ─── Gmail helpers ───────────────────────────────────────────────────────────
async function ensureLabel(gmail, labelName) {
  const list = await gmail.users.labels.list({ userId: 'me' });
  const existing = list.data.labels?.find(l => l.name === labelName);
  if (existing) return existing.id;
  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name: labelName, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  });
  return created.data.id;
}

function normalizeBody(text) {
  return text
    .replace(/<br\s*\/?>/gi, '\n')           // <br>, <br/>, <br /> → newline
    .replace(/<\/?(p|div|li|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')                 // strip remaining HTML tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')              // trim trailing spaces on lines
    .replace(/\n{3,}/g, '\n\n')              // collapse excess blank lines
    // Collapse "        Label:\n        Value" → "Label: Value" so regex sees value on same line
    .replace(/^[ \t]*(\*?(?:Name|Phone|Email|Message|Subject|Caller|Called|Time|Length|Address)\*?:)[ \t]*\n[ \t]+(?=\S)/gim, '$1 ');
}

function decodeBody(part) {
  if (!part) return '';
  if (part.body?.data) {
    const raw = Buffer.from(part.body.data, 'base64').toString('utf-8');
    return normalizeBody(raw);
  }
  if (part.parts) {
    // Prefer text/plain over text/html at the direct level
    const plain = part.parts.find(p => p.mimeType === 'text/plain' && p.body?.data);
    if (plain) return decodeBody(plain);
    const html = part.parts.find(p => p.mimeType === 'text/html' && p.body?.data);
    if (html) return decodeBody(html);
    // Recurse into nested multipart (multipart/mixed → multipart/alternative → text/*)
    for (const subpart of part.parts) {
      const result = decodeBody(subpart);
      if (result) return result;
    }
  }
  return '';
}

function getSubject(message) {
  const headers = message.payload?.headers || [];
  const h = headers.find(x => x.name.toLowerCase() === 'subject');
  return h?.value || '';
}

function getMessageDate(message) {
  const headers = message.payload?.headers || [];
  const h = headers.find(x => x.name.toLowerCase() === 'date');
  if (h?.value) return new Date(h.value);
  if (message.internalDate) return new Date(parseInt(message.internalDate, 10));
  return new Date();
}

// Format as "Mon, 27 Apr 2026, 04:46 am" — matching existing Airtable rows
function formatInquiryDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-AU', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: TZ,
  }).formatToParts(d);
  const get = (type) => parts.find(p => p.type === type)?.value || '';
  const ampm = get('dayPeriod').toLowerCase().replace(/\./g, '');
  return `${get('weekday')}, ${get('day')} ${get('month')} ${get('year')}, ${get('hour')}:${get('minute')} ${ampm}`;
}

async function fetchUnprocessedMessages(gmail, query) {
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 });
  const ids = (list.data.messages || []).map(m => m.id);
  const messages = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    messages.push(msg.data);
  }
  return messages;
}

async function applyLabel(gmail, messageId, labelId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

// ─── Airtable read/write ─────────────────────────────────────────────────────
function digitsOnly(s) { return (s || '').replace(/\D/g, ''); }

async function findExistingLead({ phone, email }) {
  if (sb.USE_SUPABASE) return sb.findLead({ phone, email });
  const phoneDigits = digitsOnly(phone);
  if (!phoneDigits && !email) return null;
  const conds = [];
  if (phoneDigits) {
    // Compare by digits-only (Airtable phones may include spaces/+)
    conds.push(`REGEX_REPLACE({Phone Number},"\\\\D","")="${phoneDigits}"`);
  }
  if (email) {
    conds.push(`LOWER({Email})="${email.toLowerCase().replace(/"/g, '\\"')}"`);
  }
  const formula = conds.length === 1 ? conds[0] : `OR(${conds.join(',')})`;
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${LEADS_TABLE_ID}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1&fields%5B%5D=Client%20Name`;
  const r = await axios.get(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  return r.data.records?.[0] || null;
}

async function writeLeadToAirtable(fields) {
  if (sb.USE_SUPABASE) { const id = await sb.createLead(fields); return { id }; }
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${LEADS_TABLE_ID}`;
  const response = await axios.post(url, { fields }, {
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
  return response.data;
}

// ─── Notification trigger ────────────────────────────────────────────────────
async function triggerWhatsAppNotification(lead) {
  const selfUrl = process.env.SELF_BASE_URL || 'http://localhost:8080';
  try {
    await axios.post(`${selfUrl}/notify-lead`, lead, { timeout: 8000 });
  } catch (err) {
    console.error('Failed to trigger WhatsApp notification:', err.message);
  }
}

// ─── Facebook/Instagram Lead-Ads sheet ingestion ─────────────────────────────
// RFC-4180-aware CSV parser (handles quoted fields, embedded commas/newlines,
// and "" escaped quotes). No external dependency.
function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(c => (c || '').trim() !== ''))
    .map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = (r[i] != null ? String(r[i]) : '').trim(); });
      return o;
    });
}

// Meta injects a test lead with placeholder values — never import it.
function isTestRow(row) {
  const email = (row.email || '').toLowerCase();
  if (email === 'test@meta.com') return true;
  const probe = `${row.full_name || ''} ${row.phone_number || ''} ${row.inbox_url || ''}`.toLowerCase();
  return probe.includes('<test lead') || probe.includes('dummy data');
}

// Map one sheet row → lead fields (Airtable-style keys, translated by sb.js).
function mapFbRowToLead(row) {
  const platform = (row.platform || '').toLowerCase();
  const label = (platform === 'ig' || platform === 'instagram') ? 'Instagram' : 'Facebook';
  const phone = String(row.phone_number || '').replace(/^p:/i, '').trim();
  const formName = (row.form_name || '').trim();
  const campaign = (row.campaign_name || '').trim();
  return {
    fbLeadId: row.id,
    fields: {
      'Client Name': (row.full_name || '').trim() || '—',
      'Phone Number': phone,
      'Email': (row.email || '').trim(),
      'Lead Source': label,
      'Inquiry Subject/Reason': `${label} Lead Ad${formName ? ` — ${formName}` : ''}`,
      'Inquiry Date': formatInquiryDate(row.created_time),
      'Notes': `📘 ${label} lead${campaign ? ` — campaign "${campaign}"` : ''}`
        + `${formName ? `, form "${formName}"` : ''}. Meta lead ${row.id}.`,
      'Lead Status': 'New Lead',
      'FB Lead Id': row.id,
    },
  };
}

function b64urlEmail(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Minimal plain-text (optionally HTML) email via the Gmail API — same transport
// invoice.js uses. Reuses buildOAuthClient() defined above.
async function sendPlainEmail({ to, subject, text, html, refreshToken }) {
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const encSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  let mime;
  if (html) {
    const boundary = 'pv_fb_notify_alt';
    mime = [
      `To: ${to}`, `Subject: ${encSubject}`, 'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(text || '').toString('base64'), '',
      `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(html).toString('base64'), '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    mime = [
      `To: ${to}`, `Subject: ${encSubject}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(text || '').toString('base64'),
    ].join('\r\n');
  }
  return gmail.users.messages.send({ userId: 'me', requestBody: { raw: b64urlEmail(mime) } });
}

async function sendFbLeadEmail(fields) {
  const to = process.env.FB_LEADS_NOTIFY_EMAIL || BUSINESS.email;
  const refreshToken = process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN;
  if (!refreshToken) { console.warn('[fb-leads] no send token — skipping email'); return; }
  const label = fields['Lead Source'];
  const subject = `New ${label} lead: ${fields['Client Name']}`;
  const text = [
    `New ${label} lead from Meta Lead Ads:`, '',
    `Name:    ${fields['Client Name']}`,
    `Phone:   ${fields['Phone Number'] || '—'}`,
    `Email:   ${fields['Email'] || '—'}`,
    `Source:  ${label}`,
    `When:    ${fields['Inquiry Date'] || '—'}`,
    `Details: ${fields['Notes']}`, '',
    `Open the dashboard: ${DASHBOARD_URL}`,
  ].join('\n');
  await sendPlainEmail({ to, subject, text, refreshToken });
}

async function extractFacebookLeads({ notify = true } = {}) {
  const csvUrl = process.env.FB_LEADS_SHEET_CSV_URL;
  if (!csvUrl) { console.warn('[fb-leads] FB_LEADS_SHEET_CSV_URL not set — skipping'); return { processed: 0, skipped: 0 }; }
  if (!sb.USE_SUPABASE) { console.warn('[fb-leads] USE_SUPABASE not true — skipping (fb_lead_id dedup needs Supabase)'); return { processed: 0, skipped: 0 }; }

  let text;
  try {
    const resp = await axios.get(csvUrl, { responseType: 'text', timeout: 15000 });
    text = String(resp.data || '');
  } catch (err) {
    console.error(`[ALERT] 🚨 [fb-leads] Failed to fetch sheet CSV: ${err.message}`);
    return { processed: 0, error: err.message };
  }

  // Sharing revoked → Google serves an HTML login page instead of CSV.
  const firstLine = (text.split('\n', 1)[0] || '');
  if (/<html|<!doctype/i.test(text.slice(0, 200)) || !/(^|,)id(,|$)/.test(firstLine)) {
    console.error('[ALERT] 🚨 [fb-leads] Sheet did not return CSV (sharing revoked / wrong URL?). Skipping.');
    return { processed: 0, error: 'non-csv-response' };
  }

  const rows = csvToObjects(text).filter(r => r.id && !isTestRow(r) && (r.phone_number || r.email));
  if (!rows.length) return { processed: 0, total: 0, skipped: 0 };

  let existing;
  try { existing = await sb.getFacebookLeadIds(); }
  catch (err) { console.error(`[ALERT] 🚨 [fb-leads] Failed to load existing ids: ${err.message}`); return { processed: 0, error: err.message }; }
  const seen = new Set(existing);

  let processed = 0, skipped = 0;
  for (const row of rows) {
    if (seen.has(row.id)) { skipped += 1; continue; }
    try {
      const { fields } = mapFbRowToLead(row);
      await sb.createLead(fields);
      seen.add(row.id);
      if (notify) {
        await sendFbLeadEmail(fields).catch(e => console.error(`[fb-leads] email failed for ${row.id}: ${e.message}`));
        await syncContactToList({
          phone: fields['Phone Number'],
          name: (fields['Client Name'] && fields['Client Name'] !== '—') ? fields['Client Name'] : '',
          email: fields['Email'],
          date: row.created_time,
        });
      }
      processed += 1;
      console.log(`[fb-leads] imported ${fields['Client Name']} (${fields['Lead Source']})`);
    } catch (err) {
      console.error(`[ALERT] 🚨 [fb-leads] Failed to import ${row.id}: ${err.message}`);
    }
  }
  return { processed, total: rows.length, skipped };
}

// ─── Main extraction routines ────────────────────────────────────────────────
async function extractFormLeads({ notify = true } = {}) {
  const refreshToken = process.env.GMAIL_FORM_REFRESH_TOKEN;
  if (!refreshToken) {
    console.warn('[email-extractor] GMAIL_FORM_REFRESH_TOKEN not set — skipping form gmail');
    return { processed: 0 };
  }
  const gmail = gmailClient(refreshToken);
  const labelId = await ensureLabel(gmail, FORM_LABEL_NAME);

  // Gmail search: subjects matching either form, NOT already labeled.
  // Date filter is configurable via env (default 6mo). Dedup protects against duplicates.
  const dateFilter = process.env.EMAIL_LOOKBACK || 'newer_than:6m';
  // Match ALL Squarespace form submissions (forms get renamed: "New Form",
  // "form windows 1", "Form windows 2", ...) by sender, plus the Pearl View form.
  // Exclude our OWN Facebook/Instagram lead-alert emails: they are sent to this
  // same inbox and — being from @pearlview.com.au with Name:/Phone:/Email: lines
  // — would otherwise be mis-parsed as website form submissions → duplicate leads.
  const query = `(${FORM_GMAIL_MATCH}) -label:"${FORM_LABEL_NAME}" -subject:"New Facebook lead" -subject:"New Instagram lead" ${dateFilter}`;
  const messages = await fetchUnprocessedMessages(gmail, query);

  let processed = 0;
  for (const message of messages) {
    try {
      const subject = getSubject(message);
      // Defensive: never ingest our own FB/IG lead-alert emails (the -subject
      // filter in the query should exclude them, but Gmail matching is fuzzy).
      if (/^\s*new (facebook|instagram) lead:/i.test(subject)) {
        console.log(`[email-extractor] Skipping own FB/IG notification email: ${subject}`);
        continue;
      }
      const from = (message.payload?.headers || []).find(h => h.name.toLowerCase() === 'from')?.value || '';
      const body = decodeBody(message.payload);

      let parsed;
      if (subject.toLowerCase().includes('form submission')) {
        // Any Squarespace form ("New Form", "form windows 1", "Form windows 2", ...)
        parsed = parseCrystalProForm(body);
      } else if (subject.toLowerCase().includes('new message from') || from.toLowerCase().includes('pearlview.com.au')) {
        // Pearl View website form — matched by subject OR sender (form emails come
        // from *@pearlview.com.au with a "Name:/Phone:/Email:/Message:/---/Date:" body).
        parsed = parsePearlViewForm(body);
      } else if (process.env.WEBSITE_SOURCE) {
        // Config-driven single-brand location (e.g. Perth): same Name/Phone/Email/
        // Message extraction as the Pearl View form; source tag comes from env.
        parsed = parsePearlViewForm(body, process.env.WEBSITE_SOURCE);
      } else {
        console.warn(`[email-extractor] Unknown form subject: ${subject} (from: ${from})`);
        continue;
      }

      if (!parsed.phone && !parsed.email) {
        console.warn(`[email-extractor] No phone/email in form ${message.id} (subject="${subject}") — body sample: ${body.substring(0, 400).replace(/\n/g, ' | ')}`);
        continue;
      }

      // Each submission is its own entry (same policy as calls). Repeat
      // senders never create duplicate clients — syncClientsFromLeads dedupes
      // by phone/email downstream.
      const existing = await findExistingLead({ phone: parsed.phone, email: parsed.email });

      const inquiryDate = formatInquiryDate(getMessageDate(message));
      const formNote = `📝 Form enquiry received ${inquiryDate}`
        + (existing ? ' — existing lead/client' : '')
        + '.';
      await writeLeadToAirtable({
        'Client Name': parsed.name || '—',
        'Phone Number': parsed.phone,
        'Email': parsed.email,
        'Inquiry Subject/Reason': parsed.subject,
        'Inquiry Date': inquiryDate,
        'Notes': formNote,
        'Lead Source': parsed.source,
        'Lead Status': 'New Lead',
      });

      await applyLabel(gmail, message.id, labelId);

      if (notify) {
        await triggerWhatsAppNotification({
          name: parsed.name,
          phone: parsed.phone,
          email: parsed.email,
          subject: parsed.subject,
          leadSource: parsed.source,
        });
        // Add to the Mobile Message broadcast list (best-effort, never throws).
        await syncContactToList({ phone: parsed.phone, name: parsed.name, email: parsed.email, date: inquiryDate });
      }

      processed += 1;
      console.log(`[email-extractor] Form lead processed: ${parsed.name} (${parsed.source})`);
    } catch (err) {
      console.error(`[ALERT] 🚨 Failed to process form email ${message.id}: ${err.message}`);
    }
  }
  return { processed, total: messages.length };
}

async function extractCallReports({ notify = true } = {}) {
  const refreshToken = process.env.GMAIL_CALL_REFRESH_TOKEN;
  if (!refreshToken) {
    console.warn('[email-extractor] GMAIL_CALL_REFRESH_TOKEN not set — skipping call gmail');
    return { processed: 0 };
  }
  const gmail = gmailClient(refreshToken);
  const labelId = await ensureLabel(gmail, CALL_LABEL_NAME);

  const dateFilter = process.env.EMAIL_LOOKBACK || 'newer_than:6m';
  const query = `subject:"Call Report" -label:"${CALL_LABEL_NAME}" ${dateFilter}`;
  const messages = await fetchUnprocessedMessages(gmail, query);

  let processed = 0;
  for (const message of messages) {
    try {
      const body = decodeBody(message.payload);
      const parsed = parseCallReport(body);

      if (!parsed.callerId) {
        console.warn(`[email-extractor] No caller ID in call report ${message.id} — body sample: ${body.substring(0, 300).replace(/\n/g, ' | ')}`);
        continue;
      }

      // Each call is its own dashboard entry (calls are events, not people).
      // We do NOT skip when the number is already a lead — but if we recognise
      // the caller, reuse their name so the entry ties to the same person.
      // Client-table de-duplication is handled downstream by syncClientsFromLeads
      // (matches by phone), so repeat callers never create duplicate clients.
      const existing = await findExistingLead({ phone: parsed.phone });
      const knownName = existing?.fields?.['Client Name'];
      const clientName = (knownName && knownName !== 'Unknown Caller' && knownName !== '—')
        ? knownName
        : 'Unknown Caller';

      const callTimeDate = parsed.callTime ? new Date(parsed.callTime.replace(' ', 'T') + 'Z') : getMessageDate(message);
      const inquiryDate = formatInquiryDate(callTimeDate);
      const callNote = `📞 Call received ${parsed.callTime || inquiryDate}`
        + (parsed.callDuration ? ` (${parsed.callDuration})` : '')
        + (existing ? ' — existing lead/client' : '')
        + '. See recording.';
      await writeLeadToAirtable({
        'Client Name': clientName,
        'Phone Number': parsed.phone,
        'Caller ID': parsed.callerId,
        'Call Time': parsed.callTime,
        'Call Duration': parsed.callDuration,
        'Inquiry Subject/Reason': 'Phone enquiry — see call recording',
        'Inquiry Date': inquiryDate,
        'Notes': callNote,
        'Lead Source': parsed.source,
        'Call - Lead Source': parsed.calledLine || '',
        'Lead Status': 'New Lead',
      });

      await applyLabel(gmail, message.id, labelId);

      if (notify) {
        await triggerWhatsAppNotification({
          name: 'Unknown Caller',
          phone: parsed.phone,
          email: '',
          subject: `Phone call ${parsed.callDuration}`,
          leadSource: parsed.source,
        });
        // Add caller to the broadcast list. Keep genuinely-unknown callers
        // phone-only (no "Unknown Caller" name on the SMS contact).
        await syncContactToList({
          phone: parsed.phone,
          name: (clientName && clientName !== 'Unknown Caller') ? clientName : '',
          email: '',
          date: inquiryDate,
        });
      }

      processed += 1;
      console.log(`[email-extractor] Call report processed: ${parsed.callerId}`);
    } catch (err) {
      console.error(`[ALERT] 🚨 Failed to process call report ${message.id}: ${err.message}`);
    }
  }
  return { processed, total: messages.length };
}

async function runExtraction({ notify = true } = {}) {
  const [form, call, facebook] = await Promise.allSettled([
    extractFormLeads({ notify }),
    extractCallReports({ notify }),
    extractFacebookLeads({ notify }),
  ]);
  return {
    form: form.status === 'fulfilled' ? form.value : { error: form.reason?.message },
    call: call.status === 'fulfilled' ? call.value : { error: call.reason?.message },
    facebook: facebook.status === 'fulfilled' ? facebook.value : { error: facebook.reason?.message },
  };
}

async function unlabelMessages(account, labelName) {
  const refreshToken = account === 'form'
    ? process.env.GMAIL_FORM_REFRESH_TOKEN
    : process.env.GMAIL_CALL_REFRESH_TOKEN;
  if (!refreshToken) throw new Error(`No refresh token for ${account}`);
  const gmail = gmailClient(refreshToken);
  const labels = await gmail.users.labels.list({ userId: 'me' });
  const label = labels.data.labels?.find(l => l.name === labelName);
  if (!label) return { removed: 0, note: `Label "${labelName}" not found` };
  const list = await gmail.users.messages.list({ userId: 'me', q: `label:"${labelName}"`, maxResults: 100 });
  const ids = (list.data.messages || []).map(m => m.id);
  for (const id of ids) {
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { removeLabelIds: [label.id] },
    });
  }
  return { removed: ids.length, ids };
}

async function applyLabelToMatching(account, labelName, query) {
  const refreshToken = account === 'form'
    ? process.env.GMAIL_FORM_REFRESH_TOKEN
    : process.env.GMAIL_CALL_REFRESH_TOKEN;
  if (!refreshToken) throw new Error(`No refresh token for ${account}`);
  const gmail = gmailClient(refreshToken);
  const labelId = await ensureLabel(gmail, labelName);
  const list = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 500 });
  const ids = (list.data.messages || []).map(m => m.id);
  for (const id of ids) {
    await gmail.users.messages.modify({
      userId: 'me',
      id,
      requestBody: { addLabelIds: [labelId] },
    });
  }
  return { labeled: ids.length };
}

module.exports = {
  runExtraction,
  buildOAuthClient,
  parseCrystalProForm,
  parsePearlViewForm,
  parseCallReport,
  unlabelMessages,
  applyLabelToMatching,
  parseCsv,
  csvToObjects,
  isTestRow,
  mapFbRowToLead,
  extractFacebookLeads,
};
