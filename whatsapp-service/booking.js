/**
 * booking.js
 * Client "rebook" flow. A client opens the booking page (linked from their
 * invoice), confirms a date/time, and this module:
 *   1. creates a row in the Airtable Bookings table (so it shows on the
 *      dashboard Calendar), and
 *   2. emails the client an .ics calendar invite from the Pearl View Gmail so
 *      the appointment locks into THEIR calendar.
 * No Google Workspace / Calendly — the .ics is generated here.
 */
const { google } = require('googleapis');
const axios = require('axios');
const { BUSINESS, BRAND_NAME, BRAND_SHORT } = require('./config');
const { verifyToken } = require('./token');
const sb = require('./sb');

const AT_BASE      = () => process.env.AIRTABLE_BASE_ID;
const AT_TOKEN     = () => process.env.AIRTABLE_TOKEN;
const LEADS_TBL    = () => process.env.AIRTABLE_TABLE_ID || 'tblS1keAU26CH08KJ';
const BOOKINGS_TBL = () => process.env.AIRTABLE_BOOKINGS_TABLE_ID || 'tbl03PFKZTim2YLzq';
const atAuth       = () => ({ Authorization: `Bearer ${AT_TOKEN()}` });

const normPhone = p => String(p || '').replace(/\D/g, '');
const todayISO = () => new Date().toISOString().slice(0, 10);
function badReq(msg) { const e = new Error(msg); e.code = 'BAD_REQUEST'; return e; }

// Availability rules: weekdays only (Mon–Fri), up to N bookings/day.
const MAX_PER_DAY = () => parseInt(process.env.REBOOK_MAX_PER_DAY || '3', 10);
const isWeekend = dateStr => { const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay(); return d === 0 || d === 6; };

async function fetchLeadById(id) {
  if (sb.USE_SUPABASE) return sb.getLeadById(id);
  const url = `https://api.airtable.com/v0/${AT_BASE()}/${LEADS_TBL()}/${id}`;
  const r = await axios.get(url, { headers: atAuth() });
  return r.data; // { id, fields }
}

async function createBooking(fields) {
  if (sb.USE_SUPABASE) return sb.createBooking(fields);
  const url = `https://api.airtable.com/v0/${AT_BASE()}/${BOOKINGS_TBL()}`;
  const r = await axios.post(url, { fields, typecast: true },
    { headers: { ...atAuth(), 'Content-Type': 'application/json' } });
  return r.data.id;
}

// All non-cancelled bookings, normalised → used for one-per-day availability and
// single-use enforcement. Paginated.
async function fetchActiveBookings() {
  if (sb.USE_SUPABASE) return sb.fetchActiveBookings();
  const out = [];
  let offset;
  do {
    const url = `https://api.airtable.com/v0/${AT_BASE()}/${BOOKINGS_TBL()}`;
    const params = { pageSize: 100 };
    if (offset) params.offset = offset;
    const r = await axios.get(url, { headers: atAuth(), params });
    for (const rec of r.data.records || []) {
      const f = rec.fields || {};
      if ((f['Booking Status'] || '') === 'Cancelled') continue;
      out.push({ date: String(f['Date'] || '').slice(0, 10), clientName: (f['Client Name'] || '').trim().toLowerCase(), phone: normPhone(f['Phone']) });
    }
    offset = r.data.offset;
  } while (offset);
  return out;
}

// Token → booking-page bootstrap. bookedDates = future days that are FULL
// (>= maxPerDay bookings) → the page blocks those + all weekends.
async function getBookInfo(token) {
  const { leadId, suggest, email } = verifyToken(token);
  const lead = await fetchLeadById(leadId);
  const f = lead?.fields || {};
  const t = todayISO();
  const bookings = await fetchActiveBookings();
  const counts = {};
  bookings.filter(b => b.date >= t).forEach(b => { counts[b.date] = (counts[b.date] || 0) + 1; });
  const cap = MAX_PER_DAY();
  const bookedDates = Object.keys(counts).filter(d => counts[d] >= cap);
  // (No single-use lock — a client can rebook whenever; weekday + daily-cap
  // limits still apply. A just-completed job must never block a new booking.)
  // Prefer the email the invoice was sent to (from the token) over the lead's
  // stored email, so the booking auto-fills the right recipient.
  return { clientName: f['Client Name'] || '', email: email || f['Email'] || '', suggest: suggest || '', bookedDates, maxPerDay: cap, weekdaysOnly: true };
}

// ── ICS generation ───────────────────────────────────────────────────────────
const icsEscape = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
// Local floating time stamp "YYYYMMDDTHHMMSS" (no Z) — interpreted as the
// attendee's local time, which matches an appointment booked at a clock time.
function icsLocal(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-');
  let hh = '09', mm = '00';
  if (timeStr && /^\d{1,2}:\d{2}/.test(timeStr)) { const [h, mi] = timeStr.split(':'); hh = h.padStart(2, '0'); mm = mi.slice(0, 2); }
  return `${y}${m}${d}T${hh}${mm}00`;
}
function addHourLocal(stamp) {
  // stamp = YYYYMMDDTHHMMSS — bump the hour by 1 (wraps within the day; jobs are daytime)
  const hh = parseInt(stamp.slice(9, 11), 10);
  const next = String(Math.min(hh + 1, 23)).padStart(2, '0');
  return stamp.slice(0, 9) + next + stamp.slice(11);
}

// METHOD:REQUEST + ATTENDEE (the client) → Google/Apple AUTO-ADD the event to
// the client's calendar (it shows immediately, with a Yes/Maybe/No on the card).
// The client booked this themselves, so it's their own appointment auto-saved.
function generateIcs({ uid, dtstampUtc, start, end, summary, description, location, organizerEmail, organizerName, attendeeEmail, attendeeName }) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${BRAND_NAME}//Rebook//EN`,
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstampUtc}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `LOCATION:${icsEscape(location)}`,
    `ORGANIZER;CN=${icsEscape(organizerName)}:mailto:${organizerEmail}`,
    `ATTENDEE;CN=${icsEscape(attendeeName)};RSVP=TRUE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

// ── Google Calendar invite (reliable auto-add) ────────────────────────────────
// Create a REAL calendar event on the Pearl View calendar with the client as an
// attendee and sendUpdates:'all'. Google then emails the client a genuine
// calendar invitation that AUTO-APPEARS on their own calendar — far more reliable
// than mailing a raw .ics. Requires the token to carry the calendar.events scope
// (mint via execution/mint_gmail_calendar_token.cjs) AND the Google Calendar API
// enabled on the OAuth client's GCP project. Throws if either is missing — the
// caller falls back to the .ics email.
function oauthClient() {
  const o = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET,
    process.env.GMAIL_OAUTH_REDIRECT_URI,
  );
  o.setCredentials({ refresh_token: process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN });
  return o;
}

async function createCalendarInvite({ clientName, email, svc, date, timeStr, address, city }) {
  const cal = google.calendar({ version: 'v3', auth: oauthClient() });
  const tz = process.env.REBOOK_TZ || 'Australia/Brisbane';
  const [h, mi] = (timeStr || '09:00').split(':');
  const hh = (h || '09').padStart(2, '0');
  const mm = (mi || '00').slice(0, 2);
  const endHh = String(Math.min(parseInt(hh, 10) + 1, 23)).padStart(2, '0');
  const res = await cal.events.insert({
    calendarId: 'primary',
    sendUpdates: 'all', // emails the attendee a real invite → auto-adds to their calendar
    requestBody: {
      summary: `${svc} — ${BRAND_SHORT}`,
      description: `Your window clean with ${BRAND_SHORT}.\nService: ${svc}\nQuestions? ${BUSINESS.email}`,
      location: address || city || '',
      start: { dateTime: `${date}T${hh}:${mm}:00`, timeZone: tz },
      end:   { dateTime: `${date}T${endHh}:${mm}:00`, timeZone: tz },
      attendees: [{ email, displayName: clientName }],
      reminders: { useDefault: true },
    },
  });
  return res.data;
}

// ── Gmail send (calendar invite) ──────────────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function encodeHeader(str) {
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf-8').toString('base64')}?=`;
}

async function sendCalendarInvite({ to, subject, html, ics }) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GMAIL_OAUTH_CLIENT_ID,
    process.env.GMAIL_OAUTH_CLIENT_SECRET,
    process.env.GMAIL_OAUTH_REDIRECT_URI,
  );
  oauth2.setCredentials({ refresh_token: process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });

  const mixed = 'pv_book_mixed_0001';
  const alt   = 'pv_book_alt_0001';
  const mime = [
    `From: ${encodeHeader(BUSINESS.name)} <${BUSINESS.email}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html.replace(/<[^>]+>/g, ''), 'utf-8').toString('base64'),
    '',
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf-8').toString('base64'),
    '',
    // text/calendar alternative — Gmail/Apple render an inline "Add to calendar"
    `--${alt}`,
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(ics, 'utf-8').toString('base64'),
    '',
    `--${alt}--`,
    '',
    // also attach as a downloadable .ics for clients whose mail strips the part
    `--${mixed}`,
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="invite.ics"',
    '',
    Buffer.from(ics, 'utf-8').toString('base64'),
    '',
    `--${mixed}--`,
  ].join('\r\n');

  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: b64url(mime) } });
  return res.data;
}

// Build the client confirmation email (subject + warm HTML + "save to calendar"
// One-tap "Add to Google Calendar" link — opens a pre-filled event in the CLIENT's
// own Google account regardless of their invite settings. This is the MOST reliable
// way to get it on their calendar (no accept step, no settings change needed). Local
// times + ctz are interpreted in the business timezone (QLD = no DST). Shown as the
// primary button on the booking confirmation screen + in the email.
function buildGcalUrl({ svc, date, timeStr, address, city }) {
  const start = icsLocal(date, timeStr);
  const end = addHourLocal(start);
  const tz = process.env.REBOOK_TZ || 'Australia/Brisbane';
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(`${svc} — ${BRAND_SHORT}`)}`
    + `&dates=${start}/${end}`
    + `&ctz=${encodeURIComponent(tz)}`
    + `&details=${encodeURIComponent(`Your window clean with ${BRAND_SHORT}.\nService: ${svc}\nQuestions? ${BUSINESS.email}`)}`
    + `&location=${encodeURIComponent(address || city || '')}`;
}

// .ics). Pure/testable — no network. Tone: the CLIENT booked; we're just helping
// them keep it. Single source of truth for both the live flow and tests.
function buildRebookEmail({ bookingId, clientName, email, svc, date, timeStr, address, city }) {
  const start = icsLocal(date, timeStr);
  const end = addHourLocal(start);
  const now = new Date();
  const dtstampUtc = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const ics = generateIcs({
    uid: `rebook-${bookingId}@pearlview`,
    dtstampUtc, start, end,
    summary: `${svc} — ${BRAND_SHORT}`,
    description: `Your window clean with ${BRAND_SHORT}.\\nService: ${svc}\\nQuestions? ${BUSINESS.email}`,
    location: address || city || '',
    organizerEmail: BUSINESS.email, organizerName: BUSINESS.name,
    attendeeEmail: email, attendeeName: clientName,
  });
  const prettyDate = new Date(`${date}T${timeStr}:00`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const gcalUrl = buildGcalUrl({ svc, date, timeStr, address, city });

  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;background:#f6f7fb;padding:24px;">
      <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">
        <div style="background:#0f766e;color:#fff;padding:18px 24px;font-size:17px;font-weight:700;">${BRAND_NAME}</div>
        <div style="padding:24px;">
          <p style="font-size:16px;margin:0 0 12px;">Hi ${clientName}, 👋</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 18px;">Thanks for booking your next window clean — all sorted! Here are the details you picked:</p>
          <div style="background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;padding:16px 18px;margin-bottom:18px;">
            <div style="font-size:16px;font-weight:700;color:#0f766e;">${svc}</div>
            <div style="font-size:15px;color:#222;margin-top:4px;">${prettyDate} at ${timeStr}</div>
            ${address ? `<div style="font-size:14px;color:#555;margin-top:2px;">${address}</div>` : ''}
          </div>
          <p style="font-size:14px;line-height:1.6;color:#444;margin:0 0 12px;">Add it to your calendar so it's handy:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;"><tr><td style="border-radius:8px;background:#0f766e;">
            <a href="${gcalUrl}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#fff;text-decoration:none;border-radius:8px;">➕ Add to Google Calendar</a>
          </td></tr></table>
          <p style="font-size:13px;line-height:1.6;color:#666;margin:0 0 6px;">On iPhone / Outlook? Open the attached <strong>invite.ics</strong> instead — it adds the same appointment.</p>
          <p style="font-size:14px;line-height:1.6;color:#444;margin:0;">Need a different time? Just reply to this email and we'll sort it.</p>
          <p style="font-size:13px;color:#999;margin-top:22px;border-top:1px solid #eee;padding-top:14px;">See you then — ${BRAND_NAME}<br/><a href="mailto:${BUSINESS.email}" style="color:#3b5bdb;">${BUSINESS.email}</a></p>
        </div>
      </div>
    </div>`;
  return { subject: `Your window clean is booked — ${prettyDate}`, html, ics, prettyDate };
}

/**
 * Orchestrate a client rebooking.
 * body: { t (signed token), date (YYYY-MM-DD), time? (HH:MM), service? }
 * - Verifies the token → lead id, enforces one-booking-per-day + single-use,
 *   creates a Bookings row, and emails the client the .ics.
 */
async function createRebooking(body = {}) {
  const { t, date, time, service, email: bodyEmail } = body;
  const { leadId, email: tokenEmail } = verifyToken(t); // throws BAD_TOKEN if invalid/expired/forged
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badReq('Please choose a valid date.');
  const today = todayISO();
  if (date < today) throw badReq('Please choose a date in the future.');

  const lead = await fetchLeadById(leadId);
  const f = lead?.fields || {};
  const clientName = f['Client Name'] || 'Client';
  // Priority: what the client typed on the booking page → the invoice-recipient
  // email carried in the token → the lead's stored email. So the invite lands on
  // whoever actually received the invoice, with a manual override if they want.
  const email = (bodyEmail && bodyEmail.trim()) || tokenEmail || f['Email'] || '';
  const phone = f['Phone Number'] || '';
  const city  = f['City'] || '';
  const address = f['Service Address'] || f['Adress'] || '';
  const svc = service || (Array.isArray(f['Services']) && f['Services'][0]) || f['Property Type'] || 'Window Cleaning';
  const timeStr = time || '09:00';

  // Availability + single-use checks against current bookings.
  if (isWeekend(date)) throw badReq('We only take bookings on weekdays (Mon–Fri) — please pick a weekday.');
  const bookings = await fetchActiveBookings();
  if (bookings.filter(b => b.date === date).length >= MAX_PER_DAY())
    throw badReq('Sorry, that day is fully booked — please pick another date.');

  // 1. Create the dashboard booking (Booking Name uses the LEAD:: convention so
  // the dashboard links it back to the lead, matching addCalBooking()).
  const bookingId = await createBooking({
    'Booking Name': `LEAD::${clientName} - ${date}`,
    'Client Name': clientName,
    'Phone': phone,
    'City': city,
    'Job_Service': svc,
    'Date': date,
    'Booking Status': 'Scheduled',
    'Job Time': timeStr,
  });

  // 2. Get it onto the client's calendar. PREFER a real Google Calendar invite
  // (auto-adds to their calendar); if that fails — token missing the calendar
  // scope, or Calendar API not enabled — fall back to mailing the .ics.
  let inviteSent = false, inviteMethod = null;
  if (email) {
    try {
      await createCalendarInvite({ clientName, email, svc, date, timeStr, address, city });
      inviteSent = true; inviteMethod = 'calendar';
    } catch (e) {
      console.error('Calendar invite failed, falling back to .ics email:', e?.message || e);
      const mail = buildRebookEmail({ bookingId, clientName, email, svc, date, timeStr, address, city });
      await sendCalendarInvite({ to: email, subject: mail.subject, html: mail.html, ics: mail.ics });
      inviteSent = true; inviteMethod = 'ics';
    }
  }

  // Always return a one-tap "Add to Google Calendar" URL — the confirmation page
  // shows it as the primary button so the client adds it in one tap, right there,
  // without needing to open email, accept an invite, or change any Google setting.
  const gcalUrl = buildGcalUrl({ svc, date, timeStr, address, city });

  return { success: true, bookingId, inviteSent, inviteMethod, gcalUrl, date, time: timeStr, clientName };
}

module.exports = { createRebooking, getBookInfo, createBooking, generateIcs, icsLocal, sendCalendarInvite, buildRebookEmail };
