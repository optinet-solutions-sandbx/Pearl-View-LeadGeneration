# Facebook/Instagram Lead-Ads Ingestion + Email Alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-ingest Meta (Facebook + Instagram) Lead-Ads leads from the Meta-populated Google Sheet into the dashboard (Supabase), deduped, and email an alert per new lead to service@pearlview.com.au.

**Architecture:** Extend the existing `whatsapp-service/email-extractor.js` with a new `extractFacebookLeads()` folded into `runExtraction()`, so it rides the existing `/extract-emails` Cloud Scheduler cron. The sheet is read as CSV over plain HTTP (link-shared, no OAuth). Dedup on Meta's stable lead `id` via a new `fb_lead_id` column on `leads`. Email alerts reuse the invoice Gmail-API send path. Frontend gains an `Instagram` lead source.

**Tech Stack:** Node.js (Express, `googleapis`, `axios`) on Cloud Run; Supabase Postgres (PostgREST); React 18 + Vite frontend.

## Global Constraints

- **No new npm dependencies** — CSV parsing is an inline RFC-4180-aware function.
- **Production DB is Supabase** — FB extraction requires `USE_SUPABASE=true`; if false, it no-ops with a warning (Airtable has no `fb_lead_id` column).
- **Exact lead field keys** (Airtable-style, translated to snake_case by `sb.js`): `Client Name`, `Phone Number`, `Email`, `Lead Source`, `Inquiry Subject/Reason`, `Inquiry Date`, `Notes`, `Lead Status`, `FB Lead Id`.
- **Lead-source values:** `platform=fb` → `Facebook`; `platform=ig` → `Instagram`; anything else → `Facebook`.
- **Email only for FB/IG leads** — never call the WhatsApp notifier for this source.
- **Never push to GitHub or deploy without explicit user approval.** Frontend deploys via `git push origin main` (Vercel auto-deploy) only when told. Cloud Run deploy needs interactive user gcloud login (reauth policy) + `CLOUDSDK_PYTHON=C:\Users\User\AppData\Local\Python\bin\python3.exe`.
- **Dashboard prod URL:** `https://pearl-view-lead-generation-rosy.vercel.app`.
- **Sheet CSV URL:** `https://docs.google.com/spreadsheets/d/1h-3Y_OMHshJyydlP6yt-Qc94UgsXEUAM8k6Z0K42e78/export?format=csv&gid=0`.

---

## File Structure

- **Modify** `whatsapp-service/email-extractor.js` — add pure helpers (`parseCsv`, `csvToObjects`, `isTestRow`, `mapFbRowToLead`), orchestration (`extractFacebookLeads`), email helpers (`sendPlainEmail`, `sendFbLeadEmail`), wire into `runExtraction`, extend exports.
- **Modify** `whatsapp-service/sb.js` — add `'FB Lead Id' → fb_lead_id` to `LEAD_COLS`; add + export `getFacebookLeadIds()`.
- **Create** `execution/supabase_add_fb_lead_id.sql` — DDL migration (run once in Supabase SQL editor).
- **Create** `execution/test_fb_extractor.cjs` — standalone assert-based test for the pure helpers.
- **Modify** `src/utils/constants.js` — add `'Instagram'` to `LEAD_SOURCES`.
- **Modify** `whatsapp-service/.env.example` — document `FB_LEADS_SHEET_CSV_URL`, `FB_LEADS_NOTIFY_EMAIL`.

---

## Task 1: Pure CSV parsing + row→lead mapping (TDD)

**Files:**
- Modify: `whatsapp-service/email-extractor.js`
- Test: `execution/test_fb_extractor.cjs`

**Interfaces:**
- Consumes: existing `formatInquiryDate(input)` (already in `email-extractor.js`).
- Produces:
  - `parseCsv(text: string) → string[][]` — rows of raw cells, RFC-4180 quotes handled.
  - `csvToObjects(text: string) → Array<Record<string,string>>` — header-keyed, trimmed, blank rows dropped.
  - `isTestRow(row) → boolean` — true for Meta's injected test lead.
  - `mapFbRowToLead(row) → { fbLeadId: string, fields: Record<string,any> }`.

- [ ] **Step 1: Write the failing test**

Create `execution/test_fb_extractor.cjs`:

```js
/* Standalone test for the Facebook lead extractor pure helpers.
   Run: node execution/test_fb_extractor.cjs   (exit 0 = pass) */
const assert = require('assert');
const {
  parseCsv, csvToObjects, isTestRow, mapFbRowToLead,
} = require('../whatsapp-service/email-extractor');

// Real sample (header + fb row + ig row + Meta test row) plus one synthetic
// quoted-comma row to prove the parser handles embedded commas.
const SAMPLE = [
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,full_name,phone_number,email,inbox_url,lead_status',
  'l:2046983545902460,2026-07-16T00:12:13+03:00,ag:1,מודעת,as:1,13.7,c:1,קמפיין לידים 13.7,f:1,Window Cleaning 13.7,false,fb,Billy French,p:+61402012700,billyfrench0325@gmail.com,https://x,CREATED',
  'l:1075817815004880,2026-07-14T09:55:56+03:00,ag:1,מודעת,as:1,13.7,c:1,קמפיין לידים 13.7,f:1,Window Cleaning 13.7,false,ig,Sze Tye,p:+61409120429,szetye@blacktye.id.au,,CREATED',
  'l:1359317866399979,2026-07-16T03:17:00-05:00,,,,,,,f:1,Window Cleaning 13.7,true,,<test lead: dummy data for full_name>,p:<test lead: dummy data for phone_number>,test@meta.com,<test lead: dummy data for inbox_url>,CREATED',
  'l:555,2026-07-10T10:00:00+10:00,ag:1,ad,as:1,13.7,c:1,Camp,f:1,Window Cleaning 13.7,false,fb,"French, Billy",p:+61400000000,comma@test.com,,CREATED',
].join('\n');

// parseCsv: quoted comma stays one field
const raw = parseCsv(SAMPLE);
assert.strictEqual(raw.length, 5, 'expected header + 4 data rows');
assert.strictEqual(raw[4][12], 'French, Billy', 'quoted comma must be one field');

// csvToObjects: header-keyed
const objs = csvToObjects(SAMPLE);
assert.strictEqual(objs.length, 4, 'expected 4 data objects');
assert.strictEqual(objs[0].full_name, 'Billy French');
assert.strictEqual(objs[0].platform, 'fb');

// isTestRow: only the Meta test row
assert.strictEqual(isTestRow(objs[0]), false);
assert.strictEqual(isTestRow(objs[2]), true, 'meta test row must be flagged');

// mapFbRowToLead: fb row
const fb = mapFbRowToLead(objs[0]);
assert.strictEqual(fb.fbLeadId, 'l:2046983545902460');
assert.strictEqual(fb.fields['Client Name'], 'Billy French');
assert.strictEqual(fb.fields['Phone Number'], '+61402012700', 'p: prefix must be stripped');
assert.strictEqual(fb.fields['Email'], 'billyfrench0325@gmail.com');
assert.strictEqual(fb.fields['Lead Source'], 'Facebook');
assert.strictEqual(fb.fields['Lead Status'], 'New Lead');
assert.strictEqual(fb.fields['FB Lead Id'], 'l:2046983545902460');
assert.ok(/Facebook Lead Ad — Window Cleaning 13\.7/.test(fb.fields['Inquiry Subject/Reason']));
assert.ok(/קמפיין לידים 13\.7/.test(fb.fields['Notes']), 'non-ASCII campaign preserved in notes');
assert.ok(/2026/.test(fb.fields['Inquiry Date']) && /Jul/.test(fb.fields['Inquiry Date']), 'date formatted');

// mapFbRowToLead: ig row → Instagram
const ig = mapFbRowToLead(objs[1]);
assert.strictEqual(ig.fields['Lead Source'], 'Instagram');
assert.ok(/Instagram Lead Ad/.test(ig.fields['Inquiry Subject/Reason']));

console.log('PASS: fb extractor pure helpers');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node execution/test_fb_extractor.cjs`
Expected: FAIL — `TypeError: parseCsv is not a function` (helpers not yet exported).

- [ ] **Step 3: Implement the pure helpers**

In `whatsapp-service/email-extractor.js`, add these functions just above the `// ─── Main extraction routines ───` banner (they use `formatInquiryDate` defined earlier in the file):

```js
// ─── Facebook/Instagram Lead-Ads sheet ingestion ─────────────────────────────
// RFC-4180-aware CSV parser (handles quoted fields, embedded commas/newlines,
// and "" escaped quotes). No external dependency.
function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1)
    .filter(r => r.some(c => (c || '').trim() !== ''))
    .map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = (r[i] != null ? String(r[i]) : '').trim(); });
      return o;
    });
}

// Meta injects a test lead with placeholder values — never import it.
function isTestRow(row) {
  const email = (row.email || '').toLowerCase();
  if (email === 'test@meta.com') return true;
  const probe = `${row.full_name || ''} ${row.phone_number || ''} ${row.inbox_url || ''}`.toLowerCase();
  return probe.includes('<test lead') || probe.includes('dummy data');
}

// Map one sheet row → lead fields (Airtable-style keys, translated by sb.js).
function mapFbRowToLead(row) {
  const platform = (row.platform || '').toLowerCase();
  const label = (platform === 'ig' || platform === 'instagram') ? 'Instagram' : 'Facebook';
  const phone = String(row.phone_number || '').replace(/^p:/i, '').trim();
  const formName = (row.form_name || '').trim();
  const campaign = (row.campaign_name || '').trim();
  return {
    fbLeadId: row.id,
    fields: {
      'Client Name': (row.full_name || '').trim() || '—',
      'Phone Number': phone,
      'Email': (row.email || '').trim(),
      'Lead Source': label,
      'Inquiry Subject/Reason': `${label} Lead Ad${formName ? ` — ${formName}` : ''}`,
      'Inquiry Date': formatInquiryDate(row.created_time),
      'Notes': `📘 ${label} lead${campaign ? ` — campaign "${campaign}"` : ''}`
        + `${formName ? `, form "${formName}"` : ''}. Meta lead ${row.id}.`,
      'Lead Status': 'New Lead',
      'FB Lead Id': row.id,
    },
  };
}
```

Then extend `module.exports` at the bottom of the file to include the new names (keep existing exports):

```js
module.exports = {
  runExtraction,
  buildOAuthClient,
  parseCrystalProForm,
  parsePearlViewForm,
  parseCallReport,
  unlabelMessages,
  applyLabelToMatching,
  parseCsv,
  csvToObjects,
  isTestRow,
  mapFbRowToLead,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node execution/test_fb_extractor.cjs`
Expected: PASS — prints `PASS: fb extractor pure helpers`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add whatsapp-service/email-extractor.js execution/test_fb_extractor.cjs
git commit -m "feat(fb-leads): CSV parse + row→lead mapping for Meta Lead-Ads sheet"
```

---

## Task 2: Supabase `fb_lead_id` column + sb.js support

**Files:**
- Create: `execution/supabase_add_fb_lead_id.sql`
- Modify: `whatsapp-service/sb.js`

**Interfaces:**
- Produces: `sb.getFacebookLeadIds() → Promise<string[]>` — all non-null `fb_lead_id` values.
- Produces: `createLead(fields)` now persists `fields['FB Lead Id']` → column `fb_lead_id`.

- [ ] **Step 1: Create the DDL migration file**

Create `execution/supabase_add_fb_lead_id.sql`:

```sql
-- Facebook/Instagram Lead-Ads ingestion: dedup key (Meta lead id).
-- Run once in the Supabase SQL editor (project zagmrxxmhyprhnhucqpo).
-- leads_enriched is `select l.*` so it inherits this column automatically.
alter table leads add column if not exists fb_lead_id text;
create unique index if not exists leads_fb_lead_id_key
  on leads (fb_lead_id) where fb_lead_id is not null;
```

- [ ] **Step 2: Add the column mapping in `sb.js`**

In `whatsapp-service/sb.js`, add `'FB Lead Id'` to the `LEAD_COLS` map (append to the last line of the object literal, before the closing brace):

```js
  'Notes': 'notes', 'City': 'city', 'Invoice Number': 'invoice_number', 'Invoice Sent': 'invoice_sent', 'Refusal Reason': 'refusal_reason',
  'FB Lead Id': 'fb_lead_id',
};
```

- [ ] **Step 3: Add + export `getFacebookLeadIds`**

In `whatsapp-service/sb.js`, add this function next to `findLead` / `createLead`:

```js
async function getFacebookLeadIds() {
  const r = await axios.get(`${URL()}/rest/v1/leads?select=fb_lead_id&fb_lead_id=not.is.null`, { headers: H() });
  return (r.data || []).map(x => x.fb_lead_id).filter(Boolean);
}
```

Extend `module.exports` to include it:

```js
module.exports = { USE_SUPABASE, getLeadById, updateLead, nextInvoiceNumber, createBooking, fetchActiveBookings, findLead, createLead, getLeadsForContext, getFacebookLeadIds };
```

- [ ] **Step 4: Sanity-check the module loads and exports the function**

Run: `node -e "const sb=require('./whatsapp-service/sb'); if(typeof sb.getFacebookLeadIds!=='function')throw new Error('missing'); console.log('PASS: sb.getFacebookLeadIds exported')"`
Expected: PASS — prints `PASS: sb.getFacebookLeadIds exported`.

- [ ] **Step 5: Commit**

```bash
git add execution/supabase_add_fb_lead_id.sql whatsapp-service/sb.js
git commit -m "feat(fb-leads): add fb_lead_id column mapping + getFacebookLeadIds (Supabase)"
```

> **Deploy dependency (not now):** the `alter table` in Step 1 must be run in the Supabase SQL editor before the live backfill in Task 5.

---

## Task 3: Orchestration — fetch, dedup, create, email

**Files:**
- Modify: `whatsapp-service/email-extractor.js`

**Interfaces:**
- Consumes: `sb.USE_SUPABASE`, `sb.getFacebookLeadIds()`, `sb.createLead(fields)`, `mapFbRowToLead`, `csvToObjects`, `isTestRow`, `buildOAuthClient`, `google` (already required at top of file), `axios`.
- Produces: `extractFacebookLeads({ notify }) → Promise<{ processed, total?, skipped?, error? }>`; `runExtraction` now returns a `facebook` key too.

- [ ] **Step 1: Add the email helpers**

In `whatsapp-service/email-extractor.js`, just below the new pure helpers from Task 1, add:

```js
function b64urlEmail(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Minimal plain-text (optionally HTML) email via the Gmail API — same transport
// invoice.js uses. Reuses buildOAuthClient() defined above.
async function sendPlainEmail({ to, subject, text, html, refreshToken }) {
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth: oauth2 });
  const encSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  let mime;
  if (html) {
    const boundary = 'pv_fb_notify_alt';
    mime = [
      `To: ${to}`, `Subject: ${encSubject}`, 'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(text || '').toString('base64'), '',
      `--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(html).toString('base64'), '',
      `--${boundary}--`,
    ].join('\r\n');
  } else {
    mime = [
      `To: ${to}`, `Subject: ${encSubject}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from(text || '').toString('base64'),
    ].join('\r\n');
  }
  return gmail.users.messages.send({ userId: 'me', requestBody: { raw: b64urlEmail(mime) } });
}

async function sendFbLeadEmail(fields) {
  const to = process.env.FB_LEADS_NOTIFY_EMAIL || 'service@pearlview.com.au';
  const refreshToken = process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN;
  if (!refreshToken) { console.warn('[fb-leads] no send token — skipping email'); return; }
  const label = fields['Lead Source'];
  const subject = `New ${label} lead: ${fields['Client Name']}`;
  const text = [
    `New ${label} lead from Meta Lead Ads:`, '',
    `Name:    ${fields['Client Name']}`,
    `Phone:   ${fields['Phone Number'] || '—'}`,
    `Email:   ${fields['Email'] || '—'}`,
    `Source:  ${label}`,
    `When:    ${fields['Inquiry Date'] || '—'}`,
    `Details: ${fields['Notes']}`, '',
    `Open the dashboard: https://pearl-view-lead-generation-rosy.vercel.app`,
  ].join('\n');
  await sendPlainEmail({ to, subject, text, refreshToken });
}
```

- [ ] **Step 2: Add `extractFacebookLeads`**

In `whatsapp-service/email-extractor.js`, add below `sendFbLeadEmail`:

```js
async function extractFacebookLeads({ notify = true } = {}) {
  const csvUrl = process.env.FB_LEADS_SHEET_CSV_URL;
  if (!csvUrl) { console.warn('[fb-leads] FB_LEADS_SHEET_CSV_URL not set — skipping'); return { processed: 0, skipped: 0 }; }
  if (!sb.USE_SUPABASE) { console.warn('[fb-leads] USE_SUPABASE not true — skipping (fb_lead_id dedup needs Supabase)'); return { processed: 0, skipped: 0 }; }

  let text;
  try {
    const resp = await axios.get(csvUrl, { responseType: 'text', timeout: 15000 });
    text = String(resp.data || '');
  } catch (err) {
    console.error(`[ALERT] 🚨 [fb-leads] Failed to fetch sheet CSV: ${err.message}`);
    return { processed: 0, error: err.message };
  }

  // Sharing revoked → Google serves an HTML login page instead of CSV.
  const firstLine = (text.split('\n', 1)[0] || '');
  if (/<html|<!doctype/i.test(text.slice(0, 200)) || !/(^|,)id(,|$)/.test(firstLine)) {
    console.error('[ALERT] 🚨 [fb-leads] Sheet did not return CSV (sharing revoked / wrong URL?). Skipping.');
    return { processed: 0, error: 'non-csv-response' };
  }

  const rows = csvToObjects(text).filter(r => r.id && !isTestRow(r) && (r.phone_number || r.email));
  if (!rows.length) return { processed: 0, total: 0, skipped: 0 };

  let existing;
  try { existing = await sb.getFacebookLeadIds(); }
  catch (err) { console.error(`[ALERT] 🚨 [fb-leads] Failed to load existing ids: ${err.message}`); return { processed: 0, error: err.message }; }
  const seen = new Set(existing);

  let processed = 0, skipped = 0;
  for (const row of rows) {
    if (seen.has(row.id)) { skipped += 1; continue; }
    try {
      const { fields } = mapFbRowToLead(row);
      await sb.createLead(fields);
      seen.add(row.id);
      if (notify) {
        await sendFbLeadEmail(fields).catch(e => console.error(`[fb-leads] email failed for ${row.id}: ${e.message}`));
      }
      processed += 1;
      console.log(`[fb-leads] imported ${fields['Client Name']} (${fields['Lead Source']})`);
    } catch (err) {
      console.error(`[ALERT] 🚨 [fb-leads] Failed to import ${row.id}: ${err.message}`);
    }
  }
  return { processed, total: rows.length, skipped };
}
```

- [ ] **Step 3: Wire into `runExtraction` and export**

Replace the existing `runExtraction` in `whatsapp-service/email-extractor.js` with:

```js
async function runExtraction({ notify = true } = {}) {
  const [form, call, facebook] = await Promise.allSettled([
    extractFormLeads({ notify }),
    extractCallReports({ notify }),
    extractFacebookLeads({ notify }),
  ]);
  return {
    form: form.status === 'fulfilled' ? form.value : { error: form.reason?.message },
    call: call.status === 'fulfilled' ? call.value : { error: call.reason?.message },
    facebook: facebook.status === 'fulfilled' ? facebook.value : { error: facebook.reason?.message },
  };
}
```

Add `extractFacebookLeads` to `module.exports` (keep all names from Task 1):

```js
module.exports = {
  runExtraction,
  buildOAuthClient,
  parseCrystalProForm,
  parsePearlViewForm,
  parseCallReport,
  unlabelMessages,
  applyLabelToMatching,
  parseCsv,
  csvToObjects,
  isTestRow,
  mapFbRowToLead,
  extractFacebookLeads,
};
```

- [ ] **Step 4: Verify the module loads and the pure test still passes**

Run: `node -e "const e=require('./whatsapp-service/email-extractor'); if(typeof e.extractFacebookLeads!=='function')throw new Error('missing'); console.log('PASS: extractFacebookLeads exported')"`
Expected: PASS — prints `PASS: extractFacebookLeads exported`.

Run: `node execution/test_fb_extractor.cjs`
Expected: PASS (Task 1 assertions still green — no regression).

- [ ] **Step 5: Commit**

```bash
git add whatsapp-service/email-extractor.js
git commit -m "feat(fb-leads): extractFacebookLeads orchestration + email alert, wired into runExtraction"
```

---

## Task 4: Frontend — add `Instagram` lead source

**Files:**
- Modify: `src/utils/constants.js:71-78`

**Interfaces:** none (data-only constant consumed by filters/dropdowns).

- [ ] **Step 1: Add `'Instagram'` to `LEAD_SOURCES`**

In `src/utils/constants.js`, update the `LEAD_SOURCES` array to include Instagram after Facebook:

```js
export const LEAD_SOURCES = [
  'website-pearlview',
  'website-crystalpro',
  'Phone Call',
  'Facebook',
  'Instagram',
  'Google',
  'Other',
];
```

- [ ] **Step 2: Verify the constant and that the app builds**

Run: `node -e "const s=require('fs').readFileSync('src/utils/constants.js','utf8'); if(!/'Instagram'/.test(s))throw new Error('missing'); console.log('PASS: Instagram in LEAD_SOURCES')"`
Expected: PASS.

Run: `npm run build`
Expected: Vite build completes with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/constants.js
git commit -m "feat(fb-leads): add Instagram as a dashboard lead source"
```

---

## Task 5: Deploy, backfill, and verify end-to-end (runbook)

**Files:**
- Modify: `whatsapp-service/.env.example` (+ local `whatsapp-service/.env`, gitignored — not committed)

This task is a runbook; several steps need the user (interactive gcloud login, Supabase SQL editor, approving the frontend push). Do not run deploys without explicit approval.

- [ ] **Step 1: Document the new env vars**

Append to `whatsapp-service/.env.example`:

```
# Facebook/Instagram Lead-Ads ingestion
FB_LEADS_SHEET_CSV_URL=   # Google Sheet CSV export URL (…/export?format=csv&gid=0)
FB_LEADS_NOTIFY_EMAIL=    # Alert recipient (default service@pearlview.com.au)
```

Add both to the local `whatsapp-service/.env` (do NOT commit `.env`):
```
FB_LEADS_SHEET_CSV_URL=https://docs.google.com/spreadsheets/d/1h-3Y_OMHshJyydlP6yt-Qc94UgsXEUAM8k6Z0K42e78/export?format=csv&gid=0
FB_LEADS_NOTIFY_EMAIL=service@pearlview.com.au
```

Commit only the example:
```bash
git add whatsapp-service/.env.example
git commit -m "docs(fb-leads): document FB_LEADS_* env vars"
```

- [ ] **Step 2: Run the DDL (USER, in Supabase SQL editor)**

Paste the contents of `execution/supabase_add_fb_lead_id.sql` into the Supabase SQL editor for project `zagmrxxmhyprhnhucqpo` and run it. Verify:
```sql
select column_name from information_schema.columns
where table_name='leads' and column_name='fb_lead_id';
```
Expected: one row (`fb_lead_id`).

- [ ] **Step 3: Local live smoke test — silent backfill (no emails)**

With the local `whatsapp-service/.env` carrying `USE_SUPABASE=true`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`, and the two new `FB_LEADS_*` vars, run a one-shot backfill that does NOT email:

```bash
node -e "require('dotenv').config({path:'whatsapp-service/.env'}); require('./whatsapp-service/email-extractor').extractFacebookLeads({notify:false}).then(r=>console.log(JSON.stringify(r,null,2)))"
```
Expected: `{ processed: <n>, total: <n>, skipped: 0 }` where `<n>` = real sheet rows minus the test row (currently 3). Confirm the new leads appear in the dashboard under Facebook / Instagram.

- [ ] **Step 4: Verify idempotency (re-run creates nothing)**

Run the exact command from Step 3 again.
Expected: `{ processed: 0, total: <n>, skipped: <n> }` — every row recognized, nothing re-created.

- [ ] **Step 5: Verify the email path (one real notification)**

Trigger a single notifying run:
```bash
node -e "require('dotenv').config({path:'whatsapp-service/.env'}); require('./whatsapp-service/email-extractor').extractFacebookLeads({notify:true}).then(r=>console.log(JSON.stringify(r,null,2)))"
```
Expected: `processed: 0` (all already imported) → **no email** (correct — nothing new). To positively confirm the email renders, temporarily add a throwaway row to the sheet (or ask the user to submit a Meta test lead), re-run, and confirm an email lands in `service@pearlview.com.au` with the correct name/phone/email/source, then delete the throwaway lead from the dashboard.

- [ ] **Step 6: Deploy backend to Cloud Run (USER approves + logs in)**

User first runs, in their own PowerShell:
```
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$env:CLOUDSDK_PYTHON="C:\Users\User\AppData\Local\Python\bin\python3.exe"
gcloud auth login sandbox@optinetsolutions.com
```
Then deploy (env vars persist; only pass the new ones):
```bash
export CLOUDSDK_PYTHON="C:/Users/User/AppData/Local/Python/bin/python3.exe"
cd whatsapp-service
gcloud run deploy pearl-view-whatsapp --source . \
  --region asia-southeast1 --project pearl-view-491114 --clear-base-image \
  --update-env-vars "^@^FB_LEADS_SHEET_CSV_URL=https://docs.google.com/spreadsheets/d/1h-3Y_OMHshJyydlP6yt-Qc94UgsXEUAM8k6Z0K42e78/export?format=csv&gid=0@FB_LEADS_NOTIFY_EMAIL=service@pearlview.com.au"
```

- [ ] **Step 7: Confirm the cron path works on Cloud Run**

```bash
curl -s -X POST "https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app/extract-emails?notify=false" | head -c 600
```
Expected: JSON with a `facebook` key, e.g. `"facebook":{"processed":0,"total":3,"skipped":3}` (already backfilled locally). Confirms the deployed service reads the sheet and dedups.

- [ ] **Step 8: Deploy frontend (USER says "push it")**

```bash
git push origin main   # Vercel auto-deploys pearl-view-lead-generation-rosy
```
Then confirm `Instagram` appears as a source filter on the live dashboard and ig leads are grouped under it.

---

## Self-Review

**Spec coverage:**
- Read sheet as CSV over HTTP → Task 3 Step 2 (axios GET). ✅
- `extractFacebookLeads` folded into `runExtraction`/cron → Task 3 Step 3. ✅
- Idempotency via `fb_lead_id` (+ unique index) → Task 2. ✅
- Test-row filtering → Task 1 (`isTestRow`) + Task 3 filter. ✅
- Field mapping (`p:` strip, platform split, `formatInquiryDate`, notes) → Task 1 (`mapFbRowToLead`). ✅
- Email-only alert to service@pearlview.com.au, reuse invoice send path → Task 3 (`sendPlainEmail`/`sendFbLeadEmail`); no WhatsApp call anywhere. ✅
- `Instagram` source in dashboard → Task 4. ✅
- First run = silent backfill → Task 5 Step 3. ✅
- Env vars + `no-op if unset` → Task 3 Step 2 guard + Task 5 Step 1. ✅
- Non-CSV / revoked-sharing `[ALERT]` handling → Task 3 Step 2. ✅
- `leads_enriched` unaffected (`select l.*`) → noted in Task 2 SQL comment. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the only "fill-in" is the intentional live throwaway-lead check in Task 5 Step 5, which is a manual verification, not code. ✅

**Type consistency:** `parseCsv`/`csvToObjects`/`isTestRow`/`mapFbRowToLead`/`extractFacebookLeads`/`getFacebookLeadIds`/`sendPlainEmail`/`sendFbLeadEmail` names and signatures match across Tasks 1–3 and the exports blocks. `mapFbRowToLead` returns `{ fbLeadId, fields }`; consumers use `.fields`. Field keys match the Global Constraints list and `sb.js` `LEAD_COLS`. ✅
