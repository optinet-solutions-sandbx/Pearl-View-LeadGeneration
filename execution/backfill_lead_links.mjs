/* Link existing null-lead_id bookings & revenue to their lead.
   Dry-run (default): prints the plan, writes nothing.
   Apply:  node execution/backfill_lead_links.mjs --apply
   Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE from .env (never printed). */
import { readFileSync } from 'node:fs';
import { findLinked } from '../src/utils/reconcile.js';

const APPLY = process.argv.includes('--apply');
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE in .env'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const get = async p => (await fetch(`${URL}/rest/v1/${p}`, { headers: H })).json();
const patch = async (table, id, body) => fetch(`${URL}/rest/v1/${table}?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

const leads = await get('leads?select=id,client_name,phone_number');
const leadRecs = leads.map(l => ({ leadId: l.id, id: l.id, phone: l.phone_number, name: l.client_name }));
const dg = s => String(s || '').replace(/\D/g, '');
const nm = s => String(s || '').trim().toLowerCase();

async function backfill(table, nameCol, phoneCol) {
  const rows = await get(`${table}?lead_id=is.null&select=id,${nameCol},${phoneCol}`);
  let linked = 0, ambiguous = 0, nomatch = 0;
  for (const r of rows) {
    const phone = r[phoneCol], name = r[nameCol];
    // ambiguity: >1 candidate lead by phone or (phone-less) name
    const cands = dg(phone)
      ? leadRecs.filter(l => dg(l.phone) === dg(phone))
      : leadRecs.filter(l => nm(l.name) === nm(name));
    if (cands.length > 1) { ambiguous++; console.log(`  AMBIGUOUS ${table} ${r.id} "${name}" -> ${cands.length} leads (skip)`); continue; }
    const hit = findLinked(leadRecs, { phone, name });
    if (!hit) { nomatch++; continue; }
    console.log(`  LINK ${table} ${r.id} "${name}" -> lead ${hit.leadId}`);
    if (APPLY) await patch(table, r.id, { lead_id: hit.leadId });
    linked++;
  }
  console.log(`${table}: ${linked} linked, ${ambiguous} ambiguous (skipped), ${nomatch} no-match. ${APPLY ? 'APPLIED' : 'DRY-RUN (no writes)'}`);
}

await backfill('bookings', 'client_name', 'phone');
await backfill('revenue',  'client_name', 'phone');
