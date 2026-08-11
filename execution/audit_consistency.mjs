/* Report (default) or repair drift across leads/bookings/revenue.
   Report: node execution/audit_consistency.mjs
   Repair: node execution/audit_consistency.mjs --repair
   Reuses computeReconcile so report and repair can't diverge.
   Phone-less same-name leads are AMBIGUOUS → skipped (never auto-touched).
   Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE from .env (never printed). */
import { readFileSync } from 'node:fs';
import { findLinked, computeReconcile } from '../src/utils/reconcile.js';

const REPAIR = process.argv.includes('--repair');
const env = Object.fromEntries(readFileSync(process.env.ENV_FILE || '.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const get = async p => (await fetch(`${URL}/rest/v1/${p}`, { headers: H })).json();
const patch = async (t, id, body) => fetch(`${URL}/rest/v1/${t}?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });
const dg = s => String(s || '').replace(/\D/g, '');
const nm = s => String(s || '').trim().toLowerCase();

// internal-status map (Airtable label → internal)
const ST = { 'New Lead': 'new', 'New': 'new', 'In Progress': 'in_progress', 'Quote Sent': 'quote_sent', 'Booked': 'booked', 'Job Done': 'job_done', 'Refused': 'refused', 'Archived': 'archived', 'Scam': 'scam' };

const leads = await get('leads?select=id,client_name,phone_number,lead_status');
const bookings = await get('bookings?select=id,client_name,phone,booking_status,amount,lead_id');
const revenue  = await get('revenue?select=id,client_name,phone,amount,status,lead_id');
const bRecs = bookings.map(b => ({ leadId: b.lead_id, phone: b.phone, name: b.client_name, _b: b }));
const rRecs = revenue.map(r => ({ leadId: r.lead_id, phone: r.phone, name: r.client_name, _r: r }));

// Ambiguous = phone-less lead sharing a name with another phone-less lead → skip.
const nameCount = {};
leads.forEach(l => { if (!dg(l.phone_number)) { const k = nm(l.client_name); nameCount[k] = (nameCount[k] || 0) + 1; } });
const isAmbiguous = l => !dg(l.phone_number) && nameCount[nm(l.client_name)] > 1;

let drift = 0, ambiguous = 0;
for (const l of leads) {
  if (isAmbiguous(l)) { ambiguous++; continue; }
  const status = ST[l.lead_status] || 'new';
  const bk = findLinked(bRecs, { leadId: l.id, phone: l.phone_number, name: l.client_name })?._b || null;
  const rv = findLinked(rRecs, { leadId: l.id, phone: l.phone_number, name: l.client_name })?._r || null;
  const { bookingPatch, revenuePatch } = computeReconcile({
    lead: { id: l.id, status },
    booking: bk ? { bookingStatus: bk.booking_status, amount: bk.amount } : null,
    revenue: rv ? { amount: rv.amount, status: rv.status } : null,
  });
  if (bookingPatch) { drift++; console.log(`DRIFT booking ${bk.id} "${l.client_name}" ${JSON.stringify(bookingPatch)}`); if (REPAIR) await patch('bookings', bk.id, bookingPatch); }
  if (revenuePatch) { drift++; console.log(`DRIFT revenue ${rv.id} "${l.client_name}" ${JSON.stringify(revenuePatch)}`); if (REPAIR) await patch('revenue', rv.id, revenuePatch); }
}

// Orphans (report only): active bookings not linked to any lead.
const linkedB = new Set();
leads.forEach(l => { if (!isAmbiguous(l)) { const b = findLinked(bRecs, { leadId: l.id, phone: l.phone_number, name: l.client_name }); if (b) linkedB.add(b._b.id); } });
const orphans = bookings.filter(b => b.booking_status !== 'Cancelled' && !linkedB.has(b.id));
orphans.forEach(b => console.log(`ORPHAN booking ${b.id} "${b.client_name}" (no lead)`));

console.log(`\n${drift} drift item(s), ${ambiguous} ambiguous lead(s) skipped, ${orphans.length} orphan booking(s). ${REPAIR ? 'REPAIRED' : 'REPORT ONLY (no writes)'}`);
