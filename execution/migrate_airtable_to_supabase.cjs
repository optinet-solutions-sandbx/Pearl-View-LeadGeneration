/**
 * migrate_airtable_to_supabase.cjs — one-off Airtable → Supabase data migration.
 * Reads every Airtable table, maps fields → snake_case columns, inserts via the
 * Supabase REST API (service_role). Resolves revenue/bookings → leads FK by
 * phone then name. Aborts if Supabase tables are non-empty (prevents dupes).
 *
 * Run:  set -a; source .env; set +a; node execution/migrate_airtable_to_supabase.cjs [--dry-run]
 */
const DRY = process.argv.includes('--dry-run');
const AT_TOKEN = process.env.AIRTABLE_TOKEN;
const AT_BASE  = process.env.AIRTABLE_BASE_ID;
const SB_URL   = process.env.SUPABASE_URL;
const SB_KEY   = process.env.SUPABASE_SERVICE_ROLE;
const T = {
  leads:    process.env.AIRTABLE_TABLE_ID || 'tblS1keAU26CH08KJ',
  revenue:  process.env.AIRTABLE_REVENUE_TABLE_ID || 'Revenue',
  bookings: process.env.AIRTABLE_BOOKINGS_TABLE_ID || 'Bookings',
  clients:  process.env.AIRTABLE_CLIENTS_TABLE_ID || 'tblvopuLt5afIpjDT',
  expenses: process.env.AIRTABLE_EXPENSES_TABLE_ID || 'Expenses',
};

// ── helpers ───────────────────────────────────────────────────────────────────
const num = v => { const f = parseFloat(v); return isNaN(f) ? null : f; };
const int = v => { const i = parseInt(v, 10); return isNaN(i) ? null : i; };
const ts  = v => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d.toISOString(); };
const day = v => { const t = ts(v); return t ? t.slice(0, 10) : null; };
const normPhone = p => String(p || '').replace(/\D/g, '');

async function atFetchAll(table) {
  const out = [];
  let offset = '';
  do {
    const url = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(table)}?pageSize=100${offset ? '&offset=' + encodeURIComponent(offset) : ''}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
    if (!r.ok) throw new Error(`Airtable ${table} ${r.status}: ${await r.text()}`);
    const j = await r.json();
    out.push(...(j.records || []));
    offset = j.offset || '';
  } while (offset);
  return out;
}

async function sbGet(table, qs = 'select=id&limit=1') {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`Supabase GET ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, rows) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(batch),
    });
    if (!r.ok) throw new Error(`Supabase INSERT ${table} ${r.status}: ${await r.text()}`);
    inserted += batch.length;
  }
  return inserted;
}

// ── field mappers ─────────────────────────────────────────────────────────────
const mapLead = r => { const f = r.fields; return {
  client_name: f['Client Name'] || null, phone_number: f['Phone Number'] || null, caller_id: f['Caller ID'] || null,
  email: f['Email'] || null, lead_source: f['Lead Source'] || null, call_lead_source: f['Call - Lead Source'] || null,
  lead_status: f['Lead Status'] || 'New Lead', call_time: ts(f['Call Time']), call_recording_transcript: f['Call Recording Transcript'] || null,
  inquiry_date: ts(f['Inquiry Date']), inquiry_subject: f['Inquiry Subject/Reason'] || null,
  service_address: f['Service Address'] || null, address: f['Adress'] || null, property_type: f['Property Type'] || null,
  services: Array.isArray(f['Services']) ? f['Services'] : [], estimated_window_count: int(f['Estimated Window Count']),
  stories: int(f['Stories']), quote_amount: num(f['Quote Amount']), final_invoice_amount: num(f['Final Invoice Amount']),
  call_duration: f['Call Duration'] || null, next_follow_up_date: day(f['Next Follow-up Date']), scheduled_cleaning_date: day(f['Scheduled Cleaning Date']),
  property_details: f['Property Details'] || null, notes: f['Notes'] || null, refusal_reason: f['Refusal Reason'] || null,
  city: f['City'] || null, invoice_number: int(f['Invoice Number']), invoice_sent: !!f['Invoice Sent'], airtable_id: r.id,
}; };
const mapRevenue = r => { const f = r.fields; return {
  revenue_name: f['Revenue Name'] || null, date: day(f['Date']), client_name: f['Client Name'] || null, phone: f['Phone'] || null,
  job_service: f['Job_Service'] || null, city: f['City'] || null, payment_method: f['Payment_Method'] || null,
  amount: num(f['Amount']), status: f['Status'] || null, airtable_id: r.id,
}; };
const mapBooking = r => { const f = r.fields; return {
  booking_name: f['Booking Name'] || null, client_name: f['Client Name'] || null, phone: f['Phone'] || null, city: f['City'] || null,
  job_service: f['Job_Service'] || null, date: ts(f['Date']), booking_status: f['Booking Status'] || null, amount: num(f['Amount']),
  job_time: f['Job Time'] || null, assigned_worker: f['Assigned Worker'] || null, upsell_amount: num(f['Upsell Amount']),
  upsell_notes: f['Upsell Notes'] || null, airtable_id: r.id,
}; };
const mapClient = r => { const f = r.fields; return {
  client_name: f['Client Name'] || f['Name'] || null, phone_number: f['Phone Number'] || f['Phone'] || null, email: f['Email'] || null,
  address: f['Adress'] || f['Service Address'] || f['Address'] || null, city: f['City'] || null, notes: f['Notes'] || null,
  property_type: f['Property Type'] || null, lead_source: f['Lead Source'] || null, status: f['Status'] || null, airtable_id: r.id,
}; };
const mapExpense = r => { const f = r.fields; return {
  expense_name: f['Expense Name'] || null, date: day(f['Date']), category: f['Category'] || null,
  amount: num(f['Amount']), description: f['Description'] || null, airtable_id: r.id,
}; };

(async () => {
  // safety: refuse to run if any table already has rows
  for (const t of ['leads', 'revenue', 'bookings', 'clients', 'expenses']) {
    const rows = await sbGet(t, 'select=id&limit=1');
    if (rows.length) { console.error(`ABORT: Supabase '${t}' already has data. Clear it before re-migrating.`); process.exit(1); }
  }

  // fetch all Airtable data
  const [atLeads, atRev, atBook, atCli, atExp] = await Promise.all([
    atFetchAll(T.leads), atFetchAll(T.revenue), atFetchAll(T.bookings), atFetchAll(T.clients), atFetchAll(T.expenses),
  ]);
  console.log(`Airtable counts → leads:${atLeads.length} revenue:${atRev.length} bookings:${atBook.length} clients:${atCli.length} expenses:${atExp.length}`);
  if (DRY) { console.log('DRY RUN — no writes.'); return; }

  // 1. leads first
  await sbInsert('leads', atLeads.map(mapLead));
  // 2. fetch them back → build phone/name → id maps for FK resolution
  const sbLeads = await sbGet('leads', 'select=id,phone_number,client_name&limit=10000');
  const byPhone = {}, byName = {};
  for (const l of sbLeads) {
    const p = normPhone(l.phone_number); if (p && !byPhone[p]) byPhone[p] = l.id;
    const n = (l.client_name || '').trim().toLowerCase(); if (n && !byName[n]) byName[n] = l.id;
  }
  const linkLead = (phone, name) => byPhone[normPhone(phone)] || byName[(name || '').trim().toLowerCase()] || null;

  // 3. clients + expenses (no FK)
  await sbInsert('clients', atCli.map(mapClient));
  await sbInsert('expenses', atExp.map(mapExpense));
  // 4. revenue + bookings with lead_id resolved
  await sbInsert('revenue', atRev.map(r => ({ ...mapRevenue(r), lead_id: linkLead(r.fields['Phone'], r.fields['Client Name']) })));
  await sbInsert('bookings', atBook.map(r => ({ ...mapBooking(r), lead_id: linkLead(r.fields['Phone'], r.fields['Client Name']) })));

  // verify counts
  const counts = {};
  for (const t of ['leads', 'revenue', 'bookings', 'clients', 'expenses']) {
    const r = await fetch(`${SB_URL}/rest/v1/${t}?select=id`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Prefer: 'count=exact', Range: '0-0' } });
    counts[t] = r.headers.get('content-range');
  }
  console.log('Supabase row counts (content-range):', JSON.stringify(counts));
  console.log('✅ Migration complete.');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
