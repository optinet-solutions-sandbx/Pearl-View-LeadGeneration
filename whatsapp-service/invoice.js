/**
 * invoice.js
 * Generates a Pearl View window-cleaning invoice PDF (pdfkit, pure JS — no
 * headless browser, so it runs fine on Cloud Run buildpacks) and emails it
 * from service@pearlview.com.au via the Gmail API.
 */

const PDFDocument = require('pdfkit');
const { google } = require('googleapis');
const axios = require('axios');
const { signToken } = require('./token');
const sb = require('./sb');
// Per-deployment business identity + branding (env-driven, NSW defaults).
const { BUSINESS, BRAND_NAME, TZ } = require('./config');

// Brand colours pulled from the template
const C = {
  blue:    '#2f3a8f', // headings / "Invoice"
  blueBar: '#2f3a8f',
  link:    '#3b5bdb', // "Total price", subtotal labels
  pink:    '#e6178c', // subtitle
  grey:    '#666666',
  rowBg:   '#f0f0f0',
  line:    '#cccccc',
};

const money = n => `$${Number(n || 0).toFixed(2)}`;

// Australian GST — added 10% on top of the (GST-exclusive) line-item amounts.
const GST_RATE = 0.1;

// Build the secure "rebook" link to our booking page. The lead id + suggested
// date are wrapped in a SIGNED, EXPIRING token (90 days) — the URL exposes no
// record id and can't be forged. Returns '' when no REBOOK_URL or no leadId.
function buildRebookUrl(leadId, suggestDate, email) {
  // Default to THIS service's own /book page (off the dashboard domain) so the
  // client link never exposes the CRM URL. REBOOK_URL can override.
  const base = process.env.REBOOK_URL || (process.env.SELF_BASE_URL ? `${process.env.SELF_BASE_URL.replace(/\/$/, '')}/book` : '');
  if (!base || !leadId) return '';
  const exp = Date.now() + 90 * 24 * 60 * 60 * 1000;
  // Carry the invoice RECIPIENT's email in the (signed) token so the booking page
  // auto-fills it and the calendar invite goes to whoever received the invoice —
  // no typing needed on the client's end.
  const t = signToken({ leadId, suggest: suggestDate, email: email || undefined, exp });
  try {
    const u = new URL(base);
    u.searchParams.set('t', t);
    return u.toString();
  } catch { return `${base}?t=${encodeURIComponent(t)}`; }
}

// Suggested next-clean date = today + REBOOK_INTERVAL_MONTHS (default 3), as YYYY-MM-DD.
function suggestedNextDate() {
  const months = parseInt(process.env.REBOOK_INTERVAL_MONTHS || '3', 10);
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// HTML invoice email body. The INVOICE is the focus (amount due is the hero);
// the optional "book your next clean" is a small, muted footer link — never a
// button. Inline styles + table layout for email-client safety.
function buildInvoiceHtml({ greeting, invoiceLabel, totalStr, rebookUrl }) {
  const rebook = rebookUrl ? `
          <tr><td style="padding-top:20px;margin-top:4px;border-top:1px solid #eee;">
            <div style="font-size:14px;color:#555;padding:6px 0 12px;">Due for another clean soon?</div>
            <a href="${rebookUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 22px;border-radius:8px;font-size:14px;">&#128197; Book your next visit</a>
          </td></tr>` : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f6f7fb;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 0;">
      <tr><td align="center">
        <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:28px 30px;font-family:Arial,Helvetica,sans-serif;color:#222;max-width:520px;">
          <tr><td style="font-size:18px;font-weight:700;color:#2f3a8f;padding-bottom:4px;">${BRAND_NAME}</td></tr>
          <tr><td style="font-size:13px;color:#888;padding-bottom:16px;">Invoice${invoiceLabel}</td></tr>
          <tr><td style="font-size:15px;line-height:1.5;">Hi${greeting},</td></tr>
          <tr><td style="font-size:15px;line-height:1.6;padding-top:10px;">Thanks for your business. Your invoice for services rendered is attached as a PDF.</td></tr>
          <tr><td style="padding:18px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;">
              <tr><td style="padding:16px 18px;">
                <div style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#0f766e;font-weight:700;">Amount due</div>
                <div style="font-size:26px;font-weight:800;color:#0f766e;margin-top:2px;">${totalStr}</div>
                <div style="font-size:12px;color:#0f766e;margin-top:2px;">incl. GST · payable by bank transfer (details on the invoice)</div>
              </td></tr>
            </table>
          </td></tr>
          <tr><td style="font-size:14px;line-height:1.6;color:#444;">Thank you,<br/>${BRAND_NAME}<br/><a href="mailto:${BUSINESS.email}" style="color:#3b5bdb;">${BUSINESS.email}</a></td></tr>
          ${rebook}
        </table>
      </td></tr>
    </table>
  </body></html>`;
}

/**
 * Build the invoice PDF.
 * @param {object} data
 * @param {number|string} data.invoiceNumber
 * @param {string} data.issueDate   - display string e.g. "22.6.2026"
 * @param {string} data.dueDate     - display string
 * @param {string} data.clientName
 * @param {string} data.project     - service address / project description
 * @param {Array<{description:string, amount:number}>} data.lineItems
 * @param {string} [data.notes]
 * @returns {Promise<Buffer>}
 */
function generateInvoicePdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 50;                 // left margin
    const R = doc.page.width - 50; // right edge
    const colRight = 360;         // right column x

    // Top blue bar
    doc.rect(L, 40, R - L, 6).fill(C.blueBar);

    // Business name
    doc.fillColor(C.blue).fontSize(22).font('Helvetica')
       .text(BUSINESS.name, L, 70);

    // Left block: address + phone
    doc.fillColor(C.grey).fontSize(10).font('Helvetica');
    let y = 100;
    BUSINESS.address.forEach(line => { doc.text(line, L, y); y += 14; });
    doc.text(BUSINESS.phone, L, y); y += 14;

    // Right block: email
    doc.fillColor(C.grey).fontSize(10)
       .text(BUSINESS.email, colRight, 100, { width: R - colRight, align: 'left' });

    // ── Bank details for transfer — clear, labelled box ──
    const bankY = 150, bankH = 60;
    doc.lineWidth(1).roundedRect(L, bankY, R - L, bankH, 5).fillAndStroke('#f6f7fc', C.line);
    doc.fillColor(C.blue).fontSize(9).font('Helvetica-Bold')
       .text('BANK DETAILS FOR TRANSFER', L + 12, bankY + 9, { characterSpacing: 0.6 });
    doc.fillColor('#000').fontSize(11).font('Helvetica-Bold')
       .text(`Account name:  ${BUSINESS.name}`, L + 12, bankY + 24);
    doc.fillColor('#000').fontSize(10.5).font('Helvetica-Bold')
       .text(`BSB:  ${BUSINESS.bsb}`, L + 12, bankY + 41, { width: 150, continued: false });
    doc.text(`Account number:  ${BUSINESS.account}`, L + 165, bankY + 41, { width: 220 });
    doc.fillColor(C.grey).fontSize(9).font('Helvetica')
       .text(`ABN ${BUSINESS.abn}`, L + 340, bankY + 42, { width: R - (L + 340) - 12, align: 'right' });

    // "Invoice" title
    doc.fillColor(C.blue).fontSize(32).font('Helvetica-Bold')
       .text('Invoice', L, 226);
    doc.fillColor(C.pink).fontSize(12).font('Helvetica-Bold')
       .text(`Issued ${data.issueDate}`, L, 264);

    // ── Invoice for / Invoice # header row ──
    let topY = 294;
    doc.fillColor('#000').fontSize(12).font('Helvetica-Bold');
    doc.text('Invoice for', L, topY);
    doc.text('Invoice #', colRight, topY);

    // Box
    const boxY = topY + 20;
    const boxH = 70;
    doc.lineWidth(1).strokeColor(C.line).rect(L, boxY, R - L, boxH).stroke();
    // vertical dividers
    const c2 = 200, c3 = colRight;
    doc.moveTo(c2, boxY).lineTo(c2, boxY + boxH).stroke();
    doc.moveTo(c3, boxY).lineTo(c3, boxY + boxH).stroke();

    doc.fillColor('#000').fontSize(10).font('Helvetica');
    doc.text(data.clientName || '', L + 8, boxY + 8, { width: c2 - L - 16 });
    doc.text(`project: ${data.project || ''}`, c2 + 8, boxY + 30, { width: c3 - c2 - 16 });
    doc.font('Helvetica').text(`#${data.invoiceNumber}`, c3 + 8, boxY + 8);
    doc.font('Helvetica-Bold').text('Due date', c3 + 8, boxY + 34);
    doc.font('Helvetica').text(data.dueDate || '', c3 + 8, boxY + 48);

    // ── Line items table ──
    let ty = boxY + boxH + 30;
    doc.moveTo(L, ty - 8).lineTo(R, ty - 8).strokeColor(C.line).stroke();
    doc.fillColor(C.blue).fontSize(13).font('Helvetica-Bold');
    doc.text('Description', L, ty);
    doc.text('Total price', colRight, ty, { width: R - colRight, align: 'right' });

    ty += 24;
    let subtotal = 0;
    (data.lineItems || []).forEach(item => {
      doc.rect(L, ty - 4, R - L, 26).fill(C.rowBg);
      doc.fillColor('#000').fontSize(11).font('Helvetica');
      doc.text(item.description || '', L + 6, ty + 2, { width: colRight - L - 12 });
      doc.text(money(item.amount), colRight, ty + 2, { width: R - colRight - 6, align: 'right' });
      subtotal += Number(item.amount || 0);
      ty += 30;
    });

    ty += 14; // small gap before the totals block

    // ── Notes + totals ──
    doc.moveTo(L, ty - 10).lineTo(R, ty - 10).strokeColor(C.line).stroke();
    doc.fillColor(C.grey).fontSize(10).font('Helvetica')
       .text(`Notes: ${data.notes || ''}`, L, ty, { width: 260 });

    const gst   = subtotal * GST_RATE;
    const total = subtotal + gst;
    doc.fillColor(C.link).fontSize(11).font('Helvetica')
       .text('Subtotal', 360, ty, { width: 90, align: 'right' });
    doc.fillColor('#000').font('Helvetica-Bold')
       .text(money(subtotal), 455, ty, { width: R - 455, align: 'right' });
    doc.fillColor(C.link).fontSize(11).font('Helvetica')
       .text('GST (10%)', 360, ty + 20, { width: 90, align: 'right' });
    doc.fillColor('#000').font('Helvetica-Bold')
       .text(money(gst), 455, ty + 20, { width: R - 455, align: 'right' });
    doc.fillColor(C.link).fontSize(11).font('Helvetica-Bold')
       .text('Total', 360, ty + 42, { width: 90, align: 'right' });
    doc.fillColor('#000').font('Helvetica-Bold')
       .text(money(total), 455, ty + 42, { width: R - 455, align: 'right' });

    doc.end();
  });
}

// ─── Gmail send ──────────────────────────────────────────────────────────────
function buildOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET,
    process.env.GMAIL_OAUTH_REDIRECT_URI,
  );
}

function b64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 encoded-word — required for non-ASCII (e.g. "—") in header values,
// otherwise the raw UTF-8 bytes get decoded as Latin-1 and turn into mojibake.
function encodeHeader(str) {
  if (/^[\x00-\x7F]*$/.test(str)) return str; // pure ASCII — leave as-is
  return `=?UTF-8?B?${Buffer.from(str, 'utf-8').toString('base64')}?=`;
}

/**
 * Send the invoice PDF as an attachment from service@pearlview.com.au.
 * Requires a refresh token with the gmail.send scope.
 */
async function sendInvoiceEmail({ to, subject, bodyText, bodyHtml, pdfBuffer, fileName, refreshToken }) {
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const mixed = 'pv_invoice_mixed_0001';   // outer: body + attachment
  const alt   = 'pv_invoice_alt_0001';     // inner: text + html alternatives
  const pdfB64  = pdfBuffer.toString('base64');
  const textB64 = Buffer.from(bodyText, 'utf-8').toString('base64');

  // Body part: when an HTML version is supplied, wrap text+html in
  // multipart/alternative so clients pick HTML but plain-text still works.
  const bodyPart = bodyHtml
    ? [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        '',
        `--${alt}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        textB64,
        '',
        `--${alt}`,
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(bodyHtml, 'utf-8').toString('base64'),
        '',
        `--${alt}--`,
      ]
    : [
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        textB64,
      ];

  const mime = [
    `From: ${encodeHeader(BUSINESS.name)} <${BUSINESS.email}>`,
    `To: ${String(to).replace(/[\r\n]+/g, ' ').trim()}`,
    `Reply-To: ${encodeHeader(BUSINESS.name)} <${BUSINESS.email}>`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    ...bodyPart,
    '',
    `--${mixed}`,
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${fileName}"`,
    '',
    pdfB64,
    '',
    `--${mixed}--`,
  ].join('\r\n');

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: b64url(mime) },
  });
  return res.data;
}

// ─── Airtable + orchestration ────────────────────────────────────────────────
const AT_BASE   = () => process.env.AIRTABLE_BASE_ID;
const AT_TOKEN  = () => process.env.AIRTABLE_TOKEN;
const LEADS_TBL = () => process.env.AIRTABLE_TABLE_ID || 'tblS1keAU26CH08KJ';
const atAuth    = () => ({ Authorization: `Bearer ${AT_TOKEN()}` });

async function fetchLeadById(id) {
  if (sb.USE_SUPABASE) return sb.getLeadById(id);
  const url = `https://api.airtable.com/v0/${AT_BASE()}/${LEADS_TBL()}/${id}`;
  const r = await axios.get(url, { headers: atAuth() });
  return r.data; // { id, fields }
}

// Next sequential invoice number = max(existing, INVOICE_START-1) + 1.
// INVOICE_START (Cloud Run env) sets the floor so the sequence continues from
// where the business left off (e.g. 210). New field → first send returns the floor.
async function computeNextInvoiceNumber() {
  if (sb.USE_SUPABASE) return sb.nextInvoiceNumber();
  const floor = parseInt(process.env.INVOICE_START || '210', 10);
  let max = floor - 1;
  let offset;
  do {
    const url = `https://api.airtable.com/v0/${AT_BASE()}/${LEADS_TBL()}`;
    const params = { pageSize: 100 };
    if (offset) params.offset = offset;
    const r = await axios.get(url, { headers: atAuth(), params });
    for (const rec of r.data.records || []) {
      const n = parseInt(rec.fields['Invoice Number'], 10);
      if (!isNaN(n) && n > max) max = n;
    }
    offset = r.data.offset;
  } while (offset);
  return max + 1;
}

async function markLeadInvoiced(id, invoiceNumber) {
  if (sb.USE_SUPABASE) return sb.updateLead(id, { 'Invoice Number': invoiceNumber, 'Invoice Sent': true });
  const url = `https://api.airtable.com/v0/${AT_BASE()}/${LEADS_TBL()}/${id}`;
  await axios.patch(url,
    { fields: { 'Invoice Number': invoiceNumber, 'Invoice Sent': true } },
    { headers: { ...atAuth(), 'Content-Type': 'application/json' } });
}

function formatDMY(d) {
  const p = new Intl.DateTimeFormat('en-AU',
    { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: TZ }).formatToParts(d);
  const g = t => p.find(x => x.type === t)?.value || '';
  return `${g('day')}.${g('month')}.${g('year')}`;
}

/**
 * End-to-end: build + send an invoice for a lead.
 * body: { leadId?, to?, clientName?, project?, description?, amount?, dueDate?, notes?, test? }
 * - test=true  → uses "TEST" number, does NOT consume a sequence number or mark the lead.
 * - test=false → assigns the next sequential number and marks the lead Invoice Sent.
 */
async function sendInvoiceForLead(body = {}) {
  const { leadId, to, clientName, project, description, amount, lineItems, dueDate, notes, test } = body;

  const lead = leadId ? await fetchLeadById(leadId) : null;
  const f = lead?.fields || {};

  // Extract a clean email from whatever was typed/pasted. Any stray character in
  // the To value (trailing space, newline, zero-width space, "Name <email>"
  // wrapping) makes Gmail reject the whole message with "Invalid To header".
  // Pulling the first email-shaped token out is bulletproof against all of these.
  // Strip zero-width / invisible chars (U+200B-200D, BOM, nbsp) FIRST — JS \s does
  // not treat them as whitespace, so a pasted address can hide one and Gmail then
  // rejects the message. Then pull the first email-shaped token out.
  const zap = s => [...String(s || '')].filter(c => ![0x200B,0x200C,0x200D,0xFEFF,0xA0].includes(c.codePointAt(0))).join('');
  const rawTo = zap(to || f['Email'] || '');
  const emailMatch = rawTo.match(/[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+/);
  const recipient = zap(emailMatch ? emailMatch[0] : rawTo.replace(/\s+/g, ''));
  if (!recipient) { const e = new Error('No recipient email on lead or request'); e.code = 'NO_EMAIL'; throw e; }

  if (!test && leadId && f['Invoice Sent']) {
    const e = new Error(`Invoice already sent for this lead (#${f['Invoice Number'] || '?'})`);
    e.code = 'ALREADY_SENT';
    throw e;
  }

  const today = new Date();
  const issueDate = formatDMY(today);
  // Allow an explicit invoiceNumber override (e.g. re-issuing a corrected copy of
  // an already-sent invoice under its original number). Otherwise assign the next
  // sequential number. Test sends always show "TEST".
  const invoiceNumber = test ? 'TEST'
    : (body.invoiceNumber != null && body.invoiceNumber !== '' ? body.invoiceNumber : await computeNextInvoiceNumber());

  // Prefer the multi-line items sent by the dashboard. Fall back to a single
  // line (legacy callers / test scripts) built from description + amount.
  const cleanLines = (Array.isArray(lineItems) ? lineItems : [])
    .map(li => ({ description: String(li.description || '').trim(), amount: Number(li.amount) || 0 }))
    .filter(li => li.description && li.amount > 0);
  const items = cleanLines.length
    ? cleanLines
    : [{ description: description || f['Property Type'] || 'window cleaning',
         amount: Number(amount != null ? amount : (f['Final Invoice Amount'] || f['Quote Amount'] || 0)) }];
  const subtotal = items.reduce((s, li) => s + li.amount, 0); // ex-GST
  const lineAmount = subtotal * (1 + GST_RATE);               // total due, GST inclusive

  const pdf = await generateInvoicePdf({
    invoiceNumber,
    issueDate,
    dueDate: dueDate || issueDate, // due on receipt
    clientName: clientName || f['Client Name'] || '',
    project: project || f['Service Address'] || f['Adress'] || '',
    lineItems: items,
    notes: notes || '',
  });

  const greeting = (clientName || f['Client Name']) ? ` ${clientName || f['Client Name']}` : '';
  const invoiceLabel = test ? ' (TEST)' : ` #${invoiceNumber}`;
  const totalStr = `$${lineAmount.toFixed(2)}`;
  const rebookUrl = buildRebookUrl(leadId, suggestedNextDate(), recipient);

  const bodyText = `Hi${greeting},\n\nThanks for your business. Your invoice${invoiceLabel} for services rendered is attached as a PDF.\n\n`
    + `Amount due: ${totalStr} (incl. GST)\nPayable by bank transfer — details are on the invoice.\n`
    + `\nThank you,\n${BRAND_NAME}\n${BUSINESS.email}`
    + (rebookUrl ? `\n\n— — —\nDue for another clean soon? Book your next visit: ${rebookUrl}` : '');
  const bodyHtml = buildInvoiceHtml({ greeting, invoiceLabel, totalStr, rebookUrl });

  const result = await sendInvoiceEmail({
    to: recipient,
    subject: `Invoice #${invoiceNumber} — ${BRAND_NAME}`,
    bodyText,
    bodyHtml,
    pdfBuffer: pdf,
    fileName: `Invoice-${invoiceNumber}.pdf`,
    // Sending uses the dedicated SEND token (pearlviewwindowcleaning), NOT the
    // form-reader token — so reconnecting the form inbox can't break invoicing.
    refreshToken: process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN,
  });

  if (!test && leadId) await markLeadInvoiced(leadId, invoiceNumber);

  return { success: true, invoiceNumber, to: recipient, amount: lineAmount, messageId: result.id, test: !!test };
}

module.exports = {
  generateInvoicePdf, sendInvoiceEmail, sendInvoiceForLead,
  computeNextInvoiceNumber, BUSINESS, buildInvoiceHtml,
};
