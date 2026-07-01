// Supabase data layer (Phases 3-4 of the Airtable→Supabase migration).
// Thin PostgREST client + a translation registry that converts between the
// Airtable FIELD NAMES the app's mutations already speak and the snake_case
// Supabase COLUMNS. This lets every existing mutation + normaliser work
// unchanged — airtableSync + useLeads.patchAirtable just delegate here when
// VITE_USE_SUPABASE === 'true'.
//
// Reads AND writes use the anon key (RLS disabled for now → matches the current
// public posture where the Airtable token already ships in the bundle). Locked
// down with RLS + auth in Phase 7. Record id = Supabase UUID (writes target it).

const SB_URL = import.meta.env.VITE_SUPABASE_URL;
const SB_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const USE_SUPABASE = import.meta.env.VITE_USE_SUPABASE === 'true';

// ── Auth (username + password via Supabase Auth; username maps to a hidden
//    internal email). Session token is used for all DB calls so RLS applies. ──
const LS = { access: 'pv_sb_access', refresh: 'pv_sb_refresh', exp: 'pv_sb_exp' };
const AUTH_DOMAIN = 'pearlview.app';

function bearer() {
  try {
    const t = localStorage.getItem(LS.access);
    const exp = parseInt(localStorage.getItem(LS.exp) || '0', 10);
    if (t && Date.now() < exp) return t;
  } catch { /* ignore */ }
  return SB_KEY; // fall back to anon (pre-login / when RLS is off)
}
const hdr = () => ({ apikey: SB_KEY, Authorization: `Bearer ${bearer()}` });
const hdrJson = () => ({ ...hdr(), 'Content-Type': 'application/json' });

export function hasSession() {
  try { return !!localStorage.getItem(LS.access) && Date.now() < parseInt(localStorage.getItem(LS.exp) || '0', 10); }
  catch { return false; }
}
function storeTokens(d, fallbackRefresh) {
  try {
    localStorage.setItem(LS.access, d.access_token);
    localStorage.setItem(LS.refresh, d.refresh_token || fallbackRefresh || '');
    localStorage.setItem(LS.exp, String(Date.now() + (d.expires_in || 3600) * 1000 - 60000));
  } catch { /* ignore */ }
}
export async function signIn(username, password) {
  const email = username.includes('@') ? username : `${username.trim()}@${AUTH_DOMAIN}`;
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) return { ok: false, error: d.error_description || d.msg || 'Invalid username or password' };
  storeTokens(d);
  return { ok: true };
}
export function signOut() { try { [LS.access, LS.refresh, LS.exp].forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ } }
export async function refreshSession() {
  let rt; try { rt = localStorage.getItem(LS.refresh); } catch { /* ignore */ }
  if (!rt) return false;
  const r = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { apikey: SB_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) return false;
  storeTokens(d, rt);
  return true;
}

// Guarantee a valid session token before a DB call. If the access token is
// expired (or within its 60s buffer), refresh it. Deduped so parallel calls
// share ONE refresh (avoids refresh-token reuse races). Returns false only when
// there's no usable session at all (→ callers must NOT wipe data / should re-login).
let _refreshP = null;
export async function ensureToken() {
  if (hasSession()) return true;
  if (!_refreshP) _refreshP = refreshSession().finally(() => { _refreshP = null; });
  return _refreshP;
}

// ── field-name → column maps (per table) ─────────────────────────────────────
const LEAD_COLS = {
  'Client Name': 'client_name', 'Phone Number': 'phone_number', 'Caller ID': 'caller_id', 'Email': 'email',
  'Lead Source': 'lead_source', 'Call - Lead Source': 'call_lead_source', 'Lead Status': 'lead_status',
  'Call Time': 'call_time', 'Call Recording Transcript': 'call_recording_transcript', 'Inquiry Date': 'inquiry_date',
  'Inquiry Subject/Reason': 'inquiry_subject', 'Service Address': 'service_address', 'Adress': 'address',
  'Property Type': 'property_type', 'Services': 'services', 'Estimated Window Count': 'estimated_window_count',
  'Stories': 'stories', 'Quote Amount': 'quote_amount', 'Final Invoice Amount': 'final_invoice_amount',
  'Call Duration': 'call_duration', 'Next Follow-up Date': 'next_follow_up_date', 'Scheduled Cleaning Date': 'scheduled_cleaning_date',
  'Property Details': 'property_details', 'Notes': 'notes', 'Refusal Reason': 'refusal_reason', 'City': 'city',
  'Invoice Number': 'invoice_number', 'Invoice Sent': 'invoice_sent',
};
const REVENUE_COLS = {
  'Revenue Name': 'revenue_name', 'Date': 'date', 'Client Name': 'client_name', 'Phone': 'phone',
  'Job_Service': 'job_service', 'City': 'city', 'Payment_Method': 'payment_method', 'Amount': 'amount', 'Status': 'status',
};
const BOOKING_COLS = {
  'Booking Name': 'booking_name', 'Client Name': 'client_name', 'Phone': 'phone', 'City': 'city',
  'Job_Service': 'job_service', 'Date': 'date', 'Booking Status': 'booking_status', 'Amount': 'amount',
  'Job Time': 'job_time', 'Assigned Worker': 'assigned_worker', 'Upsell Amount': 'upsell_amount', 'Upsell Notes': 'upsell_notes',
};
const CLIENT_COLS = {
  'Client Name': 'client_name', 'Phone Number': 'phone_number', 'Phone': 'phone_number', 'Email': 'email',
  'Adress': 'address', 'Address': 'address', 'Service Address': 'address', 'City': 'city', 'Notes': 'notes',
  'Property Type': 'property_type', 'Lead Source': 'lead_source', 'Status': 'status',
};
const EXPENSE_COLS = {
  'Expense Name': 'expense_name', 'Date': 'date', 'Category': 'category', 'Amount': 'amount', 'Description': 'description',
};

// Resolve a tableId (AT_TABLES value) → { sb, cols }. Reconstruct the AT_TABLES
// values from env here (instead of importing AT_TABLES) to avoid a circular import.
const AT = {
  leads:    import.meta.env.VITE_AIRTABLE_TABLE_ID          || 'Leads',
  revenue:  import.meta.env.VITE_AIRTABLE_REVENUE_TABLE_ID  || 'Revenue',
  calendar: import.meta.env.VITE_AIRTABLE_CALENDAR_TABLE_ID || 'Bookings',
  clients:  import.meta.env.VITE_AIRTABLE_CLIENTS_TABLE_ID  || 'Clients',
  expenses: import.meta.env.VITE_AIRTABLE_EXPENSES_TABLE_ID || 'Expenses',
};
export const SB_LEADS_TABLE = AT.leads;
const REG = {
  [AT.leads]:    { sb: 'leads',    cols: LEAD_COLS },
  [AT.revenue]:  { sb: 'revenue',  cols: REVENUE_COLS },
  [AT.calendar]: { sb: 'bookings', cols: BOOKING_COLS },
  [AT.clients]:  { sb: 'clients',  cols: CLIENT_COLS },
  [AT.expenses]: { sb: 'expenses', cols: EXPENSE_COLS },
};

const toCols = (reg, fields) => {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) { const c = reg.cols[k]; if (c) out[c] = v; }
  return out;
};
const invert = cols => { const inv = {}; for (const [f, c] of Object.entries(cols)) if (!(c in inv)) inv[c] = f; return inv; };
const toFields = (reg, row) => {
  const inv = invert(reg.cols); const fields = {};
  for (const [c, v] of Object.entries(row)) { const f = inv[c]; if (f) fields[f] = v; }
  return fields;
};

// ── low-level fetch ───────────────────────────────────────────────────────────
export async function sbSelect(path) {
  // Never read with the anon key while logged in under RLS — that returns an
  // EMPTY set and would wipe the UI. Ensure a live token first; if the session
  // can't be restored, THROW (callers keep their existing data, don't blank it).
  if (!(await ensureToken())) { const e = new Error('Not authenticated'); e.code = 'AUTH'; throw e; }
  let r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: hdr() });
  if (r.status === 401 && await refreshSession()) {
    r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: hdr() });
  }
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── generic CRUD (airtableSync delegates here) ───────────────────────────────
export async function sbCreate(tableId, fields) {
  const reg = REG[tableId]; if (!reg) { console.error('sbCreate: unknown table', tableId); return null; }
  try {
    await ensureToken();
    const r = await fetch(`${SB_URL}/rest/v1/${reg.sb}`, {
      method: 'POST', headers: { ...hdrJson(), Prefer: 'return=representation' }, body: JSON.stringify(toCols(reg, fields)),
    });
    if (!r.ok) { console.error('sbCreate failed', reg.sb, await r.text()); return null; }
    const data = await r.json(); return data[0]?.id || null;
  } catch (e) { console.error('sbCreate error', e); return null; }
}
export async function sbUpdate(tableId, recordId, fields) {
  const reg = REG[tableId]; if (!reg || !recordId) return;
  await ensureToken();
  return fetch(`${SB_URL}/rest/v1/${reg.sb}?id=eq.${recordId}`, {
    method: 'PATCH', headers: hdrJson(), body: JSON.stringify(toCols(reg, fields)),
  }).then(r => { if (!r.ok) r.text().then(t => console.error('sbUpdate failed', reg.sb, t)); })
    .catch(e => console.error('sbUpdate error', e));
}
export async function sbDelete(tableId, recordId) {
  const reg = REG[tableId]; if (!reg || !recordId) return;
  await ensureToken();
  return fetch(`${SB_URL}/rest/v1/${reg.sb}?id=eq.${recordId}`, { method: 'DELETE', headers: hdr() })
    .then(r => { if (!r.ok) r.text().then(t => console.error('sbDelete failed', reg.sb, t)); })
    .catch(e => console.error('sbDelete error', e));
}
export async function sbFetch(tableId) {
  const reg = REG[tableId]; if (!reg) return [];
  try {
    const rows = await sbSelect(`${reg.sb}?select=*`);
    return rows.map(row => ({ id: row.id, fields: toFields(reg, row) }));
  } catch (e) { console.error('sbFetch error', tableId, e); return []; }
}

// Awaitable Leads PATCH that returns the updated record in {id, fields} shape
// (so callers like changeStatus can feed it to normaliseRecord). Mirrors the
// Airtable patchAirtable return contract.
export async function sbPatchLead(recordId, fields) {
  try {
    await ensureToken();
    const r = await fetch(`${SB_URL}/rest/v1/leads?id=eq.${recordId}`, {
      method: 'PATCH', headers: { ...hdrJson(), Prefer: 'return=representation' }, body: JSON.stringify(toCols(REG[AT.leads], fields)),
    });
    if (!r.ok) { const t = await r.text(); console.error('sbPatchLead failed', t); return { __patchFailed: true, error: t }; }
    const rows = await r.json();
    return rows[0] ? sbLeadRowToRecord(rows[0]) : {};
  } catch (e) { console.error('sbPatchLead error', e); return { __patchFailed: true, error: e.message }; }
}

// ── row → Airtable {id, fields} mappers (reads; reuse existing normalisers) ────
// id = Supabase UUID so writes target Supabase.
export function sbLeadRowToRecord(row) {
  return {
    id: row.id,
    fields: {
      'Client Name': row.client_name, 'Phone Number': row.phone_number, 'Caller ID': row.caller_id, 'Email': row.email,
      'Lead Source': row.lead_source, 'Call - Lead Source': row.call_lead_source, 'Lead Status': row.lead_status,
      'Call Time': row.call_time, 'Call Recording Transcript': row.call_recording_transcript, 'Inquiry Date': row.inquiry_date,
      'Inquiry Subject/Reason': row.inquiry_subject, 'Service Address': row.service_address, 'Adress': row.address,
      'Property Type': row.property_type, 'Services': Array.isArray(row.services) ? row.services : [],
      'Estimated Window Count': row.estimated_window_count, 'Stories': row.stories, 'Quote Amount': row.quote_amount,
      'Final Invoice Amount': row.final_invoice_amount, 'Call Duration': row.call_duration,
      'Next Follow-up Date': row.next_follow_up_date, 'Scheduled Cleaning Date': row.scheduled_cleaning_date,
      'Property Details': row.property_details, 'Notes': row.notes, 'Refusal Reason': row.refusal_reason, 'City': row.city,
      'Invoice Number': row.invoice_number, 'Invoice Sent': row.invoice_sent,
    },
  };
}
export function sbBookingRowToRecord(row) {
  return { id: row.id, fields: {
    'Booking Name': row.booking_name, 'Client Name': row.client_name, 'Phone': row.phone, 'City': row.city,
    'Job_Service': row.job_service, 'Date': row.date, 'Booking Status': row.booking_status, 'Amount': row.amount,
    'Job Time': row.job_time, 'Assigned Worker': row.assigned_worker, 'Upsell Amount': row.upsell_amount, 'Upsell Notes': row.upsell_notes,
  } };
}
export function sbClientRowToRecord(row) {
  return { id: row.id, fields: {
    'Client Name': row.client_name, 'Phone Number': row.phone_number, 'Email': row.email, 'Address': row.address,
    'City': row.city, 'Notes': row.notes, 'Property Type': row.property_type, 'Lead Source': row.lead_source, 'Status': row.status,
  } };
}
