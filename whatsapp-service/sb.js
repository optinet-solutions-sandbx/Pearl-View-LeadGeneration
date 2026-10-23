/**
 * sb.js — Supabase data layer for the backend (Phase 5).
 * Uses the service_role key (server-only, bypasses RLS). Gated by USE_SUPABASE.
 * Returns leads/bookings in the Airtable {id, fields} shape so existing code
 * (invoice.js, booking.js) keeps reading f['Client Name'] etc. unchanged.
 */
const axios = require('axios');

const URL = () => process.env.SUPABASE_URL;
const KEY = () => process.env.SUPABASE_SERVICE_ROLE;
const USE_SUPABASE = process.env.USE_SUPABASE === 'true';
const H = () => ({ apikey: KEY(), Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' });

// field name → column maps (mirror the frontend)
const LEAD_COLS = {
  'Client Name': 'client_name', 'Phone Number': 'phone_number', 'Caller ID': 'caller_id', 'Email': 'email',
  'Lead Source': 'lead_source', 'Call - Lead Source': 'call_lead_source', 'Lead Status': 'lead_status',
  'Call Time': 'call_time', 'Inquiry Date': 'inquiry_date', 'Inquiry Subject/Reason': 'inquiry_subject',
  'Service Address': 'service_address', 'Adress': 'address', 'Property Type': 'property_type', 'Services': 'services',
  'Quote Amount': 'quote_amount', 'Final Invoice Amount': 'final_invoice_amount', 'Call Duration': 'call_duration',
  'Notes': 'notes', 'City': 'city', 'Invoice Number': 'invoice_number', 'Invoice Sent': 'invoice_sent', 'Refusal Reason': 'refusal_reason',
  'FB Lead Id': 'fb_lead_id',
};
const BOOKING_COLS = {
  'Booking Name': 'booking_name', 'Client Name': 'client_name', 'Phone': 'phone', 'City': 'city',
  'Job_Service': 'job_service', 'Date': 'date', 'Booking Status': 'booking_status', 'Amount': 'amount',
  'Job Time': 'job_time', 'Assigned Worker': 'assigned_worker', 'Upsell Amount': 'upsell_amount', 'Upsell Notes': 'upsell_notes',
  'Lead Id': 'lead_id',
  'Assigned Worker Id': 'assigned_worker_id', 'Tech Notes': 'tech_notes',
  'Service Address': 'service_address', 'Tech Completed At': 'tech_completed_at',
  'Client Email': 'client_email', 'Calendar Event Id': 'gcal_event_id', 'Invite Status': 'gcal_status', 'Invite Attendee': 'gcal_attendee',
};
const toCols = (map, fields) => { const o = {}; for (const [k, v] of Object.entries(fields || {})) if (map[k]) o[map[k]] = v; return o; };
const leadRowToFields = row => {
  const inv = {}; for (const [f, c] of Object.entries(LEAD_COLS)) if (!(c in inv)) inv[c] = f;
  const fields = {}; for (const [c, v] of Object.entries(row)) if (inv[c]) fields[inv[c]] = v;
  return fields;
};

async function getLeadById(id) {
  const r = await axios.get(`${URL()}/rest/v1/leads?id=eq.${id}&select=*`, { headers: H() });
  const row = r.data[0];
  return row ? { id: row.id, fields: leadRowToFields(row) } : null;
}
async function updateLead(id, fields) {
  await axios.patch(`${URL()}/rest/v1/leads?id=eq.${id}`, toCols(LEAD_COLS, fields), { headers: H() });
}
async function nextInvoiceNumber() {
  const r = await axios.post(`${URL()}/rest/v1/rpc/next_invoice_number`, {}, { headers: H() });
  return r.data;
}
async function createBooking(fields) {
  const r = await axios.post(`${URL()}/rest/v1/bookings`, toCols(BOOKING_COLS, fields),
    { headers: { ...H(), Prefer: 'return=representation' } });
  return r.data[0]?.id;
}
async function updateBooking(id, fields) {
  await axios.patch(`${URL()}/rest/v1/bookings?id=eq.${id}`, toCols(BOOKING_COLS, fields), { headers: H() });
}
async function fetchActiveBookings() {
  const r = await axios.get(`${URL()}/rest/v1/bookings?select=date,client_name,phone,booking_status`, { headers: H() });
  return (r.data || []).filter(b => (b.booking_status || '') !== 'Cancelled')
    .map(b => ({ date: String(b.date || '').slice(0, 10), clientName: (b.client_name || '').trim().toLowerCase(), phone: String(b.phone || '').replace(/\D/g, '') }));
}
// Lead ingestion (email-extractor): dedup + create
async function findLead({ phone, email }) {
  const ors = [];
  if (phone) ors.push(`phone_number.eq.${String(phone).replace(/\D/g, '')}`); // note: stored may have spaces; best-effort
  if (email) ors.push(`email.ilike.${email}`);
  if (!ors.length) return null;
  const r = await axios.get(`${URL()}/rest/v1/leads?or=(${ors.join(',')})&select=id,client_name&limit=1`, { headers: H() });
  return r.data[0] || null;
}
async function createLead(fields) {
  const r = await axios.post(`${URL()}/rest/v1/leads`, toCols(LEAD_COLS, fields),
    { headers: { ...H(), Prefer: 'return=representation' } });
  return r.data[0]?.id;
}
async function getLeadsForContext() {
  const r = await axios.get(`${URL()}/rest/v1/leads?select=client_name,lead_status,quote_amount,final_invoice_amount,inquiry_date,lead_source,refusal_reason,phone_number`, { headers: H() });
  return (r.data || []).map(row => ({ fields: leadRowToFields(row) }));
}

async function getFacebookLeadIds() {
  const r = await axios.get(`${URL()}/rest/v1/leads?select=fb_lead_id&fb_lead_id=not.is.null`, { headers: H() });
  return (r.data || []).map(x => x.fb_lead_id).filter(Boolean);
}

// ── Quote follow-ups (followup.js). Raw snake_case rows — no field-name mapping.
const QUOTE_SENT = encodeURIComponent('Quote Sent');

async function getFollowupSettings() {
  try {
    const r = await axios.get(`${URL()}/rest/v1/followup_settings?id=eq.1&select=*`, { headers: H() });
    return r.data[0] || null;
  } catch (err) {
    if (err.response?.status === 404) return null; // table not created on this branch yet
    throw err;
  }
}

async function fetchDueFollowups({ nowIso, testOnly, limit }) {
  let q = `leads?followup_status=eq.active&lead_status=eq.${QUOTE_SENT}&followup_next_at=lte.${encodeURIComponent(nowIso)}`
    + '&select=id,client_name,email,quote_amount,quote_sent_at,followup_step,followup_fail_count'
    + `&order=followup_next_at.asc&limit=${limit}`;
  if (testOnly) q += '&client_name=ilike.test*'; // test mode: held real leads never crowd out TEST leads
  const r = await axios.get(`${URL()}/rest/v1/${q}`, { headers: H() });
  return r.data || [];
}

// Atomically take a due lead for this run by pushing next_at forward (a lease).
// false = another run took it, or its state changed since it was selected.
async function claimFollowup(id, step, now, leaseMin) {
  const q = `leads?id=eq.${id}&followup_status=eq.active&followup_step=eq.${step}&lead_status=eq.${QUOTE_SENT}`
    + `&followup_next_at=lte.${encodeURIComponent(now.toISOString())}`;
  const lease = new Date(now.getTime() + leaseMin * 60000).toISOString();
  const r = await axios.patch(`${URL()}/rest/v1/${q}`, { followup_next_at: lease },
    { headers: { ...H(), Prefer: 'return=representation' } });
  return Array.isArray(r.data) && r.data.length === 1;
}

// Apply a follow-up state change ONLY while the lead is still active + in Quote
// Sent — a status the owner set mid-run (e.g. Booked) is never overwritten.
async function updateActiveFollowup(id, cols) {
  const q = `leads?id=eq.${id}&followup_status=eq.active&lead_status=eq.${QUOTE_SENT}`;
  const r = await axios.patch(`${URL()}/rest/v1/${q}`, cols, { headers: { ...H(), Prefer: 'return=representation' } });
  return Array.isArray(r.data) && r.data.length === 1;
}

async function insertFollowupLog(row) {
  await axios.post(`${URL()}/rest/v1/followup_log`, row, { headers: H() });
}

// ── Calendar invitations (calendar-sync.js). Raw snake_case rows.
async function getCalendarInviteSettings() {
  try {
    const r = await axios.get(`${URL()}/rest/v1/calendar_invite_settings?id=eq.1&select=*`, { headers: H() });
    return r.data[0] || null;
  } catch (err) {
    if (err.response?.status === 404) return null; // table not created yet
    throw err;
  }
}

async function fetchBookingsToSync({ nowIso, testOnly = false, limit = 25 }) {
  // Test mode: only TEST-named rows or rows that already have an event, so held
  // real bookings never crowd the batch.
  const due = `or(gcal_next_at.is.null,gcal_next_at.lte.${encodeURIComponent(nowIso)})`;
  const filter = testOnly ? `&and=(${due},or(client_name.ilike.test*,gcal_event_id.not.is.null))` : `&${due.replace('or(', 'or=(')}`;
  const q = 'bookings?gcal_sync_needed=eq.true'
    + filter
    + '&select=id,client_name,client_email,date,job_time,booking_status,job_service,service_address,city,'
    + 'gcal_event_id,gcal_status,gcal_attendee,gcal_sync_needed,gcal_rev,gcal_fail_count,gcal_next_at'
    + `&order=gcal_next_at.asc.nullsfirst&limit=${limit}`;
  const r = await axios.get(`${URL()}/rest/v1/${q}`, { headers: H() });
  return r.data || [];
}

// Lease a flagged booking for this run (pushes gcal_next_at forward). false = taken
// by another run, or the booking changed (gcal_rev) / was unflagged since selected.
async function claimBookingSync(id, rev, now, leaseMin) {
  const q = `bookings?id=eq.${id}&gcal_rev=eq.${rev}&gcal_sync_needed=eq.true`
    + `&or=(gcal_next_at.is.null,gcal_next_at.lte.${encodeURIComponent(now.toISOString())})`;
  const lease = new Date(now.getTime() + leaseMin * 60000).toISOString();
  const r = await axios.patch(`${URL()}/rest/v1/${q}`, { gcal_next_at: lease },
    { headers: { ...H(), Prefer: 'return=representation' } });
  return Array.isArray(r.data) && r.data.length === 1;
}

// Record a just-created Google event on the booking, filtered by id ONLY (no rev
// guard) so an edit made mid-sync can't lose it. Touches only gcal_* columns, so
// the bookings_gcal_mark trigger never re-flags; service_role passes the tech guard.
async function recordBookingEvent(id, eventId, attendee) {
  await axios.patch(`${URL()}/rest/v1/bookings?id=eq.${id}`, { gcal_event_id: eventId, gcal_attendee: attendee }, { headers: H() });
}

// Write the sync result ONLY if the booking is still at the revision we synced;
// false = the office edited it mid-sync, so it stays flagged for the next run.
async function finishBookingSync(id, rev, patch) {
  const q = `bookings?id=eq.${id}&gcal_rev=eq.${rev}`;
  const r = await axios.patch(`${URL()}/rest/v1/${q}`, patch, { headers: { ...H(), Prefer: 'return=representation' } });
  return Array.isArray(r.data) && r.data.length === 1;
}

module.exports = {
  getCalendarInviteSettings, fetchBookingsToSync, claimBookingSync, recordBookingEvent, finishBookingSync,
  USE_SUPABASE, getLeadById, updateLead, nextInvoiceNumber, createBooking, updateBooking, fetchActiveBookings, findLead, createLead,
  getLeadsForContext, getFacebookLeadIds,
  getFollowupSettings, fetchDueFollowups, claimFollowup, updateActiveFollowup, insertFollowupLog,
};
