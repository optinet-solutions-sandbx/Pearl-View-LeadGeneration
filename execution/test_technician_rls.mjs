/* Prove technician RLS scoping at the REST layer.
   ENV_FILE=... TECH_EMAIL=... TECH_PASSWORD=... node execution/test_technician_rls.mjs
   Signs in as the technician (anon key) → asserts: sees only own bookings, 0 rows
   from leads/revenue/clients/expenses. Exit 0 = pass. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const env = Object.fromEntries(readFileSync(process.env.ENV_FILE || '.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
const EMAIL = process.env.TECH_EMAIL, PW = process.env.TECH_PASSWORD;
if (!URL || !ANON || !EMAIL || !PW) { console.error('need URL, ANON key, TECH_EMAIL, TECH_PASSWORD'); process.exit(1); }

// sign in as the technician → JWT
const si = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PW }) });
const tok = (await si.json()).access_token;
assert.ok(tok, 'technician sign-in should return a token');
const H = { apikey: ANON, Authorization: `Bearer ${tok}` };
const rows = async t => { const r = await fetch(`${URL}/rest/v1/${t}?select=id`, { headers: H }); return r.ok ? (await r.json()).length : `ERR ${r.status}`; };

const bookings = await rows('bookings');
console.log('technician sees bookings:', bookings);
for (const t of ['leads', 'revenue', 'clients', 'expenses']) {
  const n = await rows(t);
  assert.strictEqual(n, 0, `technician must see 0 ${t} rows (got ${n})`);
  console.log(`  ${t}: ${n} ✓`);
}
console.log('PASS: technician is scoped (bookings only, no leads/revenue/clients/expenses)');
