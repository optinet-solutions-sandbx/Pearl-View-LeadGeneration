/**
 * POST /api/mm-sync-all   (optional ?dryRun=1)
 *
 * Backstop sync for leads that arrived via the form webhook / phone-call /
 * Facebook ingest — those bypass the dashboard's addLead hook, so they never
 * trigger the per-lead mm-sync-contact call.
 *
 * DATA SOURCE: reads from **Supabase** (leads + clients) when SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE are set. The DB migrated off Airtable (2026-06-30), so
 * the old Airtable-only diff was looking at a frozen archive whose phones were
 * already in the list — it stopped adding anything, and post-migration leads
 * never reached the broadcast list. Falls back to Airtable if Supabase env is
 * absent (rollback safety).
 *
 * Flow:
 *   1. Fetch all lead/client phones from the active data source (paginated).
 *   2. Fetch all existing Mobile Message contacts + the broadcast-list members.
 *   3. Diff phones → create+add anything missing (cap 20/call, Vercel 10s).
 * With ?dryRun=1 it reports the backlog counts WITHOUT writing to Mobile Message.
 *
 * Idempotent. Safe to call repeatedly (e.g. from the Contacts page Refresh).
 */

const MAX_SYNCS_PER_CALL = 20;

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

// ── Data source: Supabase (PostgREST, service_role bypasses RLS) ──────────────
async function sbFetchAll(sbUrl, sbKey, table, select) {
  const rows = [];
  const limit = 1000;
  let offset = 0;
  while (true) {
    const r = await fetch(`${sbUrl}/rest/v1/${table}?select=${select}&limit=${limit}&offset=${offset}`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` },
    });
    if (!r.ok) throw new Error(`Supabase ${table} ${r.status}`);
    const batch = await r.json();
    rows.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return rows;
}

// Returns a Map<normalizedPhone, {phone,name,email,date}> from Supabase.
async function buildSupabaseContacts(sbUrl, sbKey) {
  const [leads, clients] = await Promise.all([
    sbFetchAll(sbUrl, sbKey, 'leads', 'phone_number,caller_id,client_name,email,inquiry_date,call_time,created_at'),
    sbFetchAll(sbUrl, sbKey, 'clients', 'phone_number,client_name,email,created_at'),
  ]);
  const byPhone = new Map();
  for (const row of leads) {
    const phone = normalisePhone(row.phone_number || row.caller_id);
    if (!phone || phone.length < 10) continue;
    const date = row.inquiry_date || row.call_time || row.created_at || '';
    if (!byPhone.has(phone)) {
      byPhone.set(phone, { phone, name: row.client_name || '', email: row.email || '', date });
    } else if (date && !byPhone.get(phone).date) {
      byPhone.get(phone).date = date;
    }
  }
  for (const row of clients) {
    const phone = normalisePhone(row.phone_number);
    if (!phone || phone.length < 10) continue;
    const existing = byPhone.get(phone);
    byPhone.set(phone, {
      phone,
      name:  row.client_name || (existing?.name || ''),
      email: row.email || (existing?.email || ''),
      date:  existing?.date || row.created_at || '',
    });
  }
  return byPhone;
}

// ── Data source: Airtable (fallback when Supabase env is absent) ──────────────
async function atFetchAll(baseId, tableId, token) {
  const records = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Airtable ${tableId} ${r.status}`);
    const d = await r.json();
    records.push(...d.records);
    offset = d.offset;
  } while (offset);
  return records;
}

async function buildAirtableContacts(baseId, token) {
  const LEADS_TABLE   = 'tblS1keAU26CH08KJ';
  const CLIENTS_TABLE = 'tblvopuLt5afIpjDT';
  const [leads, clients] = await Promise.all([
    atFetchAll(baseId, LEADS_TABLE, token),
    atFetchAll(baseId, CLIENTS_TABLE, token),
  ]);
  const byPhone = new Map();
  for (const r of leads) {
    const f = r.fields;
    const phone = normalisePhone(f['Phone Number'] || f['Caller ID']);
    if (!phone || phone.length < 10) continue;
    const date = f['Inquiry Date'] || f['Call Time'] || r.createdTime || '';
    if (!byPhone.has(phone)) {
      byPhone.set(phone, { phone, name: f['Client Name'] || '', email: f['Email'] || '', date });
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
  return byPhone;
}

// ── Mobile Message readers ────────────────────────────────────────────────────
async function mmFetchAllPhones(auth) {
  const phones = new Set();
  const limit = 200;
  let offset = 0;
  while (true) {
    const r = await fetch(
      `https://api.mobilemessage.com.au/v1/contacts?limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!r.ok) throw new Error(`MM contacts ${r.status}`);
    const d = await r.json();
    const batch = d.results || [];
    for (const c of batch) if (c.number) phones.add(String(c.number));
    if (batch.length < limit) break;
    offset += limit;
  }
  return phones;
}

async function mmFetchListPhones(auth, listId) {
  const phones = new Set();
  const limit = 200;
  let offset = 0;
  while (true) {
    const r = await fetch(
      `https://api.mobilemessage.com.au/v1/list-contacts?list_id=${listId}&limit=${limit}&offset=${offset}`,
      { headers: { Authorization: `Basic ${auth}` } }
    );
    if (!r.ok) throw new Error(`MM list-contacts ${r.status}`);
    const d = await r.json();
    const batch = d.results || [];
    for (const c of batch) if (c.number) phones.add(String(c.number));
    if (batch.length < limit) break;
    offset += limit;
  }
  return phones;
}

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const dryRun = String(req.query?.dryRun || '') === '1' || req.query?.dryRun === true;

  // URL can reuse the client var (same value); the service-role key must be its
  // own server-only var (never VITE_ — that would ship it in the browser bundle).
  const SB_URL   = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').trim();
  const SB_KEY   = (process.env.SUPABASE_SERVICE_ROLE || '').trim();
  const AT_TOKEN = (process.env.AIRTABLE_TOKEN || '').trim();
  const AT_BASE  = (process.env.AIRTABLE_BASE_ID || '').trim();
  const MM_USER    = (process.env.MM_USERNAME || '').trim();
  const MM_PASS    = (process.env.MM_API_PASSWORD || '').trim();
  const MM_LIST_ID = Number(process.env.MM_LIST_ID || 0);

  const useSupabase = !!(SB_URL && SB_KEY);
  const source = useSupabase ? 'supabase' : 'airtable';

  if (!MM_USER || !MM_PASS || !MM_LIST_ID) {
    return res.status(500).json({ error: 'Missing Mobile Message env vars' });
  }
  if (!useSupabase && !(AT_TOKEN && AT_BASE)) {
    return res.status(500).json({ error: 'No data source configured (need Supabase or Airtable env vars)' });
  }

  const auth = Buffer.from(`${MM_USER}:${MM_PASS}`).toString('base64');

  try {
    const [byPhone, mmPhones, listPhones] = await Promise.all([
      useSupabase ? buildSupabaseContacts(SB_URL, SB_KEY) : buildAirtableContacts(AT_BASE, AT_TOKEN),
      mmFetchAllPhones(auth),
      mmFetchListPhones(auth, MM_LIST_ID),
    ]);

    const allSourcePhones = [...byPhone.values()];

    // Two categories of "missing from broadcast list":
    //   A. Phone exists in the DB but not in MM at all → CREATE + add-to-list
    //   B. Phone exists in MM but not in the broadcast list → just add-to-list
    const missingFromMm = allSourcePhones.filter(e => !mmPhones.has(e.phone));
    const inMmNotInList = [...mmPhones].filter(p => !listPhones.has(p));

    // Dry run: report the backlog without touching Mobile Message.
    if (dryRun) {
      return res.status(200).json({
        ok: true, dryRun: true, source,
        totalSource:     allSourcePhones.length,
        totalInMm:       mmPhones.size,
        inBroadcastList: listPhones.size,
        missingFromMm:   missingFromMm.length,
        inMmNotInList:   inMmNotInList.length,
        wouldSync:       missingFromMm.length + inMmNotInList.length,
      });
    }

    // Total work to do, capped per invocation to stay under Vercel's 10s budget.
    let budget = MAX_SYNCS_PER_CALL;
    let createdInMm = 0;
    let addedToList = 0;
    const errors = [];

    // Category A — create-then-add
    for (const e of missingFromMm) {
      if (budget-- <= 0) break;
      const { first, last } = splitName(e.name);
      const ymd = toYmd(e.date);
      const contactBody = { number: e.phone };
      if (first) contactBody.first_name = first;
      if (last)  contactBody.last_name  = last;
      if (e.email) contactBody.other    = e.email;
      if (ymd)   contactBody.field_1    = ymd;

      const cr = await fetch('https://api.mobilemessage.com.au/v1/contacts', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(contactBody),
      });
      if (!cr.ok) {
        errors.push({ phone: e.phone, stage: 'create', status: cr.status });
        continue;
      }
      const lr = await fetch('https://api.mobilemessage.com.au/v1/list-contacts', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: MM_LIST_ID, number: e.phone }),
      });
      if (lr.ok) createdInMm++;
      else errors.push({ phone: e.phone, stage: 'list', status: lr.status });
    }

    // Category B — already in MM, just needs list assignment
    for (const phone of inMmNotInList) {
      if (budget-- <= 0) break;
      const lr = await fetch('https://api.mobilemessage.com.au/v1/list-contacts', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: MM_LIST_ID, number: phone }),
      });
      if (lr.ok) addedToList++;
      else errors.push({ phone, stage: 'list-only', status: lr.status });
    }

    const totalRemaining =
      Math.max(0, missingFromMm.length - createdInMm - errors.filter(e => e.stage === 'create').length) +
      Math.max(0, inMmNotInList.length - addedToList - errors.filter(e => e.stage === 'list-only').length);

    return res.status(200).json({
      ok: true,
      source,
      totalSource:     allSourcePhones.length,
      totalInMm:       mmPhones.size,
      inBroadcastList: listPhones.size,
      missingFromMm:   missingFromMm.length,
      inMmNotInList:   inMmNotInList.length,
      syncedNow:       createdInMm + addedToList,
      createdInMm,
      addedToList,
      remaining:       totalRemaining,
      errors:          errors.slice(0, 10),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, source, error: err.message });
  }
};
