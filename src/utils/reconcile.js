// Pure linkage core — NO imports, no import.meta, no browser globals (so Node
// .mjs scripts can import it directly alongside the Vite frontend).

const digits = s => String(s || '').replace(/\D/g, '');
const norm   = s => String(s || '').trim().toLowerCase();

// Find the record (booking or revenue) linked to a lead. lead_id wins; then
// phone (digits); then Client Name — but name ONLY when the lead has no phone,
// so a different same-named lead never matches.
export function findLinked(records, { leadId, phone, name }) {
  const list = records || [];
  if (leadId) {
    const byId = list.find(r => r.leadId && r.leadId === leadId);
    if (byId) return byId;
  }
  const ph = digits(phone);
  if (ph) return list.find(r => digits(r.phone) === ph) || null;
  const nm = norm(name);
  if (nm) return list.find(r => norm(r.name) === nm) || null;
  return null;
}

// Compute the patches to make a lead's linked booking + revenue consistent.
// Pure + idempotent. Returns Airtable-style field patches (or null = no change).
export function computeReconcile({ lead, booking, revenue }) {
  return {
    bookingPatch: booking ? bookingPatchFor(lead, booking, revenue) : null,
    revenuePatch: revenue ? revenuePatchFor(lead, revenue) : null,
  };
}

function bookingPatchFor(lead, booking, revenue) {
  const patch = {};
  // Status: only an ACTIVE (Scheduled) booking transitions. Cancelled/Completed
  // are terminal (never resurrect a cancelled booking).
  if (booking.bookingStatus === 'Scheduled') {
    let desired = 'Scheduled';
    if (lead.status === 'job_done') desired = 'Completed';
    else if (lead.status === 'booked') desired = 'Scheduled';
    else desired = 'Cancelled';                 // lead left Booked → cancel it
    if (desired !== booking.bookingStatus) patch['Booking Status'] = desired;
  }
  // Amount: the payment (revenue) is the source of truth when it exists. Don't
  // bother touching a cancelled booking's amount.
  if (booking.bookingStatus !== 'Cancelled' && revenue && revenue.amount != null
      && Number(revenue.amount) !== Number(booking.amount)) {
    patch['Amount'] = Number(revenue.amount);
  }
  return Object.keys(patch).length ? patch : null;
}

function revenuePatchFor(lead, revenue) {
  const desired = lead.status === 'job_done' ? 'Job Done' : 'In Progress';
  return revenue.status !== desired ? { 'Status': desired } : null;
}
