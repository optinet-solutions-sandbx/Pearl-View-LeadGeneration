/**
 * POST /api/mm-sync-all
 *
 * Backstop sync for leads that arrived in Airtable via the form webhook or
 * phone-call ingest — those bypass the dashboard's addLead hook so they
 * never trigger the per-lead mm-sync-contact call.
 *
 * Flow:
 *   1. Fetch all Airtable Leads + Clients (paginated).
 *   2. Fetch all existing Mobile Message contacts (paginated).
 *   3. Diff Airtable phones vs MM phones.
 *   4. Create + add-to-list any missing — but cap each invocation at 20
 *      syncs so we stay well under the Vercel 10s function timeout.
 *
 * Idempotent. Safe to call repeatedly (e.g. from the Contacts page Refresh
 * button). Returns counts so the UI can show "synced 3 missing leads."
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

  const AT_TOKEN = (process.env.AIRTABLE_TOKEN || '').trim();
  const AT_BASE  = (process.env.AIRTABLE_BASE_ID || '').trim();
  const LEADS_TABLE   = 'tblS1keAU26CH08KJ';
  const CLIENTS_TABLE = 'tblvopuLt5afIpjDT';
  const MM_USER    = (process.env.MM_USERNAME || '').trim();
  const MM_PASS    = (process.env.MM_API_PASSWORD || '').trim();
  const MM_LIST_ID = Number(process.env.MM_LIST_ID || 0);

  if (!AT_TOKEN || !AT_BASE || !MM_USER || !MM_PASS || !MM_LIST_ID) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const auth = Buffer.from(`${MM_USER}:${MM_PASS}`).toString('base64');

  try {
    const [leads, clients, mmPhones, listPhones] = await Promise.all([
      atFetchAll(AT_BASE, LEADS_TABLE, AT_TOKEN),
      atFetchAll(AT_BASE, CLIENTS_TABLE, AT_TOKEN),
      mmFetchAllPhones(auth),
      mmFetchListPhones(auth, MM_LIST_ID),
    ]);

    // Dedupe Airtable rows by normalized phone, keeping the most useful
    // record's name + inquiry date for each.
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

    const allAirtablePhones = [...byPhone.values()];

    // Two categories of "missing from broadcast list":
    //   A. Phone exists in Airtable but not in MM at all → CREATE + add-to-list
    //   B. Phone exists in MM but not in the broadcast list → just add-to-list
    //      (these are contacts uploaded manually to MM that bypassed our sync)
    const missingFromMm   = allAirtablePhones.filter(e => !mmPhones.has(e.phone));
    const inMmNotInList   = [...mmPhones].filter(p => !listPhones.has(p));

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
      totalAirtable:   allAirtablePhones.length,
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
    return res.status(500).json({ ok: false, error: err.message });
  }
};
