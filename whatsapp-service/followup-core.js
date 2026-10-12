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

module.exports = {
  FOLLOWUP_HEADER, FOLLOWUP_KIND, REFUSAL_CODE,
  cleanEmail, firstName, formatMoney, renderTemplate, buildContext,
  htmlFromText, b64url, buildFollowupMime, isFollowupMessage, replyAlertText,
};
