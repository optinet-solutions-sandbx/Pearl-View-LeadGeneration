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

module.exports = { USE_SUPABASE, getLeadById, updateLead, nextInvoiceNumber, createBooking, fetchActiveBookings, findLead, createLead, getLeadsForContext, getFacebookLeadIds };
