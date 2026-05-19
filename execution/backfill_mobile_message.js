/**
 * backfill_mobile_message.js
 *
 * One-off: takes every unique phone number from the Airtable Leads + Clients
 * tables and ensures it's in the Mobile Message broadcast list (MM_LIST_ID).
 *
 * For each phone:
 *   1. If the contact already exists in Mobile Message (e.g. one the owner
 *      previously uploaded manually), we DO NOT overwrite name/date — we
 *      only make sure they're in the broadcast list.
 *   2. If the contact is new, we create it with first_name, last_name, and
 *      field_1 = inquiry date (YYYY-MM-DD) so MM can sort by date.
 *
 * Usage:
 *   node execution/backfill_mobile_message.js            # live run
 *   node execution/backfill_mobile_message.js --dry-run  # preview
 *
 * Idempotent — safe to re-run.
 */

// Credentials are loaded from .env (gitignored) so they don't leak into
// commit history. Run as: `node execution/backfill_mobile_message.js`.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) {
    console.error('Could not load .env:', e.message);
  }
}
loadEnv();

const AT_TOKEN = process.env.AIRTABLE_TOKEN   || process.env.VITE_AIRTABLE_TOKEN || '';
const AT_BASE  = process.env.AIRTABLE_BASE_ID || process.env.VITE_AIRTABLE_BASE_ID || '';
const LEADS_TABLE   = 'tblS1keAU26CH08KJ';
const CLIENTS_TABLE = 'tblvopuLt5afIpjDT';

const MM_USER    = process.env.MM_USERNAME     || process.env.VITE_MM_USERNAME     || '';
const MM_PASS    = process.env.MM_API_PASSWORD || process.env.VITE_MM_API_PASSWORD || '';
const MM_LIST_ID = Number(process.env.MM_LIST_ID || process.env.VITE_MM_LIST_ID || 0);

if (!AT_TOKEN || !AT_BASE || !MM_USER || !MM_PASS || !MM_LIST_ID) {
  console.error('Missing required env vars. Set AIRTABLE_TOKEN, AIRTABLE_BASE_ID, MM_USERNAME, MM_API_PASSWORD, MM_LIST_ID in .env');
  process.exit(1);
}

const DRY_RUN = process.argv.includes('--dry-run');

const MM_AUTH = Buffer.from(`${MM_USER}:${MM_PASS}`).toString('base64');
const MM_HEADERS = {
  Authorization: `Basic ${MM_AUTH}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

function normalisePhone(input) {
  if (!input) return '';
  let s = String(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '61' + s.slice(1);
  if (s.length === 9 && s.startsWith('4')) s = '61' + s;
  return s;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function toYmd(input) {
  if (!input) return '';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

async function atFetchAll(tableId) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${AT_BASE}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!res.ok) throw new Error(`Airtable ${tableId} ${res.status}: ${await res.text()}`);
    const data = await res.json();
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// Pull every existing MM contact phone number into a Set so we can decide
// per-phone whether to create-with-name-and-date or just add-to-list.
async function fetchExistingMmPhones() {
  const phones = new Set();
  const limit = 200;
  let offset = 0;
  while (true) {
    const res = await fetch(
      `https://api.mobilemessage.com.au/v1/contacts?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Basic ${MM_AUTH}` } }
    );
    if (!res.ok) throw new Error(`MM /v1/contacts ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const results = data.results || [];
    for (const c of results) {
      if (c.number) phones.add(String(c.number));
    }
    if (results.length < limit) break;
    offset += limit;
  }
  return phones;
}

async function mmCreateContact({ number, first_name, last_name, other, field_1 }) {
  const body = { number };
  if (first_name) body.first_name = first_name;
  if (last_name)  body.last_name  = last_name;
  if (other)      body.other      = other;
  if (field_1)    body.field_1    = field_1;
  const res = await fetch('https://api.mobilemessage.com.au/v1/contacts', {
    method: 'POST', headers: MM_HEADERS, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function mmAddToList(number) {
  const res = await fetch('https://api.mobilemessage.com.au/v1/list-contacts', {
    method: 'POST', headers: MM_HEADERS,
    body: JSON.stringify({ list_id: MM_LIST_ID, number }),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  console.log(DRY_RUN ? '🟡 DRY RUN — no MM writes\n' : '🟢 LIVE — syncing to Mobile Message\n');

  console.log('Fetching Airtable records…');
  const [leads, clients] = await Promise.all([
    atFetchAll(LEADS_TABLE),
    atFetchAll(CLIENTS_TABLE),
  ]);
  console.log(`  Leads:   ${leads.length}`);
  console.log(`  Clients: ${clients.length}`);

  console.log('Fetching existing Mobile Message contacts…');
  const existingMm = await fetchExistingMmPhones();
  console.log(`  Existing MM contacts: ${existingMm.size}\n`);

  // Dedupe Airtable by normalized phone. Prefer Clients table for cleaner
  // names; for the inquiry date prefer whichever record has one set.
  const byPhone = new Map();
  for (const r of leads) {
    const f = r.fields;
    const phone = normalisePhone(f['Phone Number'] || f['Caller ID']);
    if (!phone || phone.length < 10) continue;
    const date = f['Inquiry Date'] || f['Call Time'] || r.createdTime || '';
    if (!byPhone.has(phone)) {
      byPhone.set(phone, {
        phone, name: f['Client Name'] || '', email: f['Email'] || '', date,
      });
    } else if (date && !byPhone.get(phone).date) {
      byPhone.get(phone).date = date;
    }
  }
  for (const r of clients) {
    const f = r.fields;
    const phone = normalisePhone(f['Phone Number'] || f['Phone']);
    if (!phone || phone.length < 10) continue;
    const existing = byPhone.get(phone);
    byPhone.set(phone, {
      phone,
      name:  f['Client Name'] || f['Name'] || (existing?.name || ''),
      email: f['Email'] || (existing?.email || ''),
      date:  existing?.date || r.createdTime || '',
    });
  }

  const entries = [...byPhone.values()];
  const toCreate = entries.filter(e => !existingMm.has(e.phone));
  const toListOnly = entries.filter(e => existingMm.has(e.phone));

  console.log(`Unique Airtable phones: ${entries.length}`);
  console.log(`  → new to MM (will create + add to list): ${toCreate.length}`);
  console.log(`  → already in MM (will just ensure in list): ${toListOnly.length}\n`);

  if (DRY_RUN) {
    console.log('Sample new contacts (first 5):');
    toCreate.slice(0, 5).forEach(e => {
      const d = toYmd(e.date);
      console.log(`  ${e.phone}  ${e.name || '(no name)'}  ${d || '(no date)'}`);
    });
    console.log('\nRe-run without --dry-run to push to Mobile Message.');
    return;
  }

  let created = 0, listOnly = 0, fail = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isNew = !existingMm.has(e.phone);
    try {
      if (isNew) {
        const { first, last } = splitName(e.name);
        const ymd = toYmd(e.date);
        const cr = await mmCreateContact({
          number: e.phone,
          first_name: first,
          last_name: last,
          other: e.email || '',
          field_1: ymd,
        });
        if (cr.status < 200 || cr.status >= 300) {
          console.log(`  [${i + 1}/${entries.length}] CREATE FAIL ${e.phone} status=${cr.status}`);
        }
      }
      const lr = await mmAddToList(e.phone);
      if (lr.status >= 200 && lr.status < 300) {
        if (isNew) {
          created++;
          console.log(`  [${i + 1}/${entries.length}] NEW    ${e.phone}  ${e.name || ''}`);
        } else {
          listOnly++;
          console.log(`  [${i + 1}/${entries.length}] EXISTS ${e.phone}`);
        }
      } else {
        fail++;
        console.log(`  [${i + 1}/${entries.length}] LIST FAIL ${e.phone} status=${lr.status} ${JSON.stringify(lr.data).slice(0, 120)}`);
      }
    } catch (err) {
      fail++;
      console.log(`  [${i + 1}/${entries.length}] ERR ${e.phone}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone. ${created} created, ${listOnly} already-existing added to list, ${fail} failed.`);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
