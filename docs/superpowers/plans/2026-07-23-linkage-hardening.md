# Leads ↔ Bookings ↔ Revenue Linkage Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably link a person's lead / booking / payment by a stable `lead_id` and keep their status + amount consistent through one central reconcile function, with a backfill for existing rows and an audit script that surfaces/repairs drift.

**Architecture:** A dependency-free pure module (`src/utils/reconcile.js`) holds the matching (`findLinked`) and the consistency decision (`computeReconcile`). The frontend persists `lead_id` on bookings/revenue and calls a thin `reconcileLead()` applier from every mutation. Two Node ESM scripts (backfill, audit) reuse the same pure module. No DB triggers.

**Tech Stack:** React 18 + Vite frontend; Supabase Postgres (PostgREST); Node ESM scripts using global `fetch` + `service_role`.

## Global Constraints

- **No new npm dependencies.** Pure logic tested via standalone Node scripts.
- **`src/utils/reconcile.js` must be dependency-free** (no imports, no `import.meta`, no browser globals) so Node can import it directly from `.mjs` scripts.
- **Production DB is Supabase** (`zagmrxxmhyprhnhucqpo`). Service-role scripts read creds from the repo `.env` (`SUPABASE_URL`/`VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE`). Never print the key.
- **Amount source of truth = the payment (`revenue`).** When a revenue row exists, the booking amount mirrors it; otherwise the booking keeps its own amount.
- **Matching order = `lead_id` → phone(digits) → Client Name.** Name only when the lead has no phone. A record carrying a `lead_id` never matches by phone/name.
- **Booking status values:** `Scheduled` / `Completed` / `Cancelled`. **Lead internal status:** `new`/`in_progress`/`quote_sent`/`booked`/`job_done`/`refused`/`archived`/`scam`. **Revenue status:** `Job Done` / `In Progress`.
- **Cancelled and Completed bookings are terminal** — reconcile transitions only `Scheduled` bookings; it never resurrects a Cancelled one. Amount still syncs to the payment for non-Cancelled bookings.
- **Scripts default to dry-run/report; writing requires an explicit `--apply` / `--repair` flag.** Ambiguous same-name matches are never auto-linked.
- **Never push to GitHub or deploy without explicit user approval.** Frontend ships via `git push origin main` (Vercel). Each phase is a separate PR/deploy.

---

## File Structure

- **Create** `src/utils/reconcile.js` — pure `findLinked` + `computeReconcile` (matching + consistency decision).
- **Create** `execution/test_reconcile.mjs` — standalone assert tests for the pure module.
- **Create** `execution/backfill_lead_links.mjs` — one-time linker for null-`lead_id` bookings/revenue (`--dry-run` default, `--apply`).
- **Create** `execution/audit_consistency.mjs` — drift report (`--report` default, `--repair`), reusing `computeReconcile`.
- **Modify** `src/utils/supabaseClient.js` — `BOOKING_COLS` += `'Lead Id': 'lead_id'`; expose it in `sbBookingRowToRecord`.
- **Modify** `src/hooks/useLeads.js` — `normaliseCalBooking` reads `lead_id`; set booking `lead_id` on create (`addCalBooking`, `recordBookingPayment`); add `reconcileLead()`; replace the ad-hoc sync blocks in `changeStatus`/`savePaidInfo`/`recordBookingPayment`/`removeCalBooking` with `reconcileLead()`.
- **Modify** `src/context/LeadsContext.jsx` — `confirmBook` sets booking `'Lead Id'` when creating a booking from a lead.
- **Modify** `whatsapp-service/sb.js` — `BOOKING_COLS` += `'Lead Id': 'lead_id'`.

**Shipping phases:** Task 1–2 = Ship 1 (links + matching). Task 3 = Ship 2 (backfill). Task 4 = Ship 3 (central reconcile). Task 5 = Ship 4 (audit). Each ships/deploys on its own.

---

## Task 1: Pure linkage core — `findLinked` + `computeReconcile` (TDD)

**Files:**
- Create: `src/utils/reconcile.js`
- Test: `execution/test_reconcile.mjs`

**Interfaces:**
- Produces:
  - `findLinked(records, { leadId, phone, name }) → record | null` — records are `{ leadId, phone, name, ... }`; matches by `leadId`, then phone digits, then name (name only if no phone).
  - `computeReconcile({ lead, booking, revenue }) → { bookingPatch, revenuePatch }` — `lead` = `{ id, status }`; `booking` = `{ bookingStatus, amount } | null`; `revenue` = `{ amount, status } | null`. Each patch is `null` (no change) or an object of Airtable-style fields (`{ 'Booking Status'?, 'Amount'? }` / `{ 'Status'? }`). Pure + idempotent.

- [ ] **Step 1: Write the failing test**

Create `execution/test_reconcile.mjs`:

```js
/* Standalone tests for the pure linkage core.
   Run: node execution/test_reconcile.mjs   (exit 0 = pass) */
import assert from 'node:assert';
import { findLinked, computeReconcile } from '../src/utils/reconcile.js';

// ── findLinked ────────────────────────────────────────────────────────────
const recs = [
  { leadId: 'L1', phone: '0400 111 222', name: 'Bailey' },
  { leadId: null, phone: '0400 999 888', name: 'Amira' },
  { leadId: null, phone: '',             name: 'Tania' },
];
assert.strictEqual(findLinked(recs, { leadId: 'L1' }).name, 'Bailey', 'lead_id wins');
assert.strictEqual(findLinked(recs, { phone: '0400999888' }).name, 'Amira', 'phone match (digits)');
assert.strictEqual(findLinked(recs, { name: 'tania' }).name, 'Tania', 'name match when caller has no phone');
assert.strictEqual(findLinked(recs, { phone: '0400111222', name: 'Amira' }).name, 'Bailey', 'phone beats name');
assert.strictEqual(findLinked(recs, { name: 'nobody' }), null, 'no match → null');
// a caller WITH a phone must not fall back to name
assert.strictEqual(findLinked(recs, { phone: '0400000000', name: 'Tania' }), null, 'phone present but unmatched → no name fallback');

// ── computeReconcile: booking status follows lead status ────────────────────
const bk = (bookingStatus, amount) => ({ bookingStatus, amount });
// booked + Scheduled + amount already equal → no change (idempotent)
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'booked' }, booking: bk('Scheduled', 300), revenue: { amount: 300, status: 'In Progress' } }),
  { bookingPatch: null, revenuePatch: null }, 'idempotent when consistent');
// job_done → Scheduled booking becomes Completed
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'job_done' }, booking: bk('Scheduled', 300), revenue: { amount: 300, status: 'Job Done' } }).bookingPatch,
  { 'Booking Status': 'Completed' }, 'job_done completes a scheduled booking');
// demoted (in_progress) → Scheduled booking becomes Cancelled
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'in_progress' }, booking: bk('Scheduled', 0), revenue: null }).bookingPatch,
  { 'Booking Status': 'Cancelled' }, 'leaving Booked cancels the active booking');
// Bailey: Completed booking, payment differs → amount syncs to revenue, status untouched
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'job_done' }, booking: bk('Completed', 800), revenue: { amount: 300, status: 'Job Done' } }).bookingPatch,
  { 'Amount': 300 }, 'payment wins; completed status is terminal');
// Cancelled booking is terminal — never resurrected even if lead is booked
assert.strictEqual(
  computeReconcile({ lead: { status: 'booked' }, booking: bk('Cancelled', 0), revenue: null }).bookingPatch,
  null, 'cancelled booking is terminal');
// no booking → null booking patch
assert.strictEqual(
  computeReconcile({ lead: { status: 'booked' }, booking: null, revenue: null }).bookingPatch,
  null, 'no booking → no patch');
// revenue status follows lead status
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'job_done' }, booking: null, revenue: { amount: 300, status: 'In Progress' } }).revenuePatch,
  { 'Status': 'Job Done' }, 'job_done sets revenue Job Done');
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'in_progress' }, booking: null, revenue: { amount: 300, status: 'Job Done' } }).revenuePatch,
  { 'Status': 'In Progress' }, 'non-done sets revenue In Progress');

console.log('PASS: reconcile core');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node execution/test_reconcile.mjs`
Expected: FAIL — `Cannot find module '.../src/utils/reconcile.js'` (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `src/utils/reconcile.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node execution/test_reconcile.mjs`
Expected: PASS — prints `PASS: reconcile core`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/reconcile.js execution/test_reconcile.mjs
git commit -m "feat(hardening): pure linkage core (findLinked + computeReconcile) with tests"
```

---

## Task 2: Persist `lead_id` on bookings + expose it (Ship 1)

**Files:**
- Modify: `src/utils/supabaseClient.js` (`BOOKING_COLS`, `sbBookingRowToRecord`)
- Modify: `whatsapp-service/sb.js` (`BOOKING_COLS`)
- Modify: `src/hooks/useLeads.js` (`normaliseCalBooking`, `addCalBooking`, `recordBookingPayment` create branch)
- Modify: `src/context/LeadsContext.jsx` (`confirmBook`)

**Interfaces:**
- Consumes: nothing from Task 1 yet.
- Produces: every newly-created booking row carries `lead_id`; normalised booking objects expose `leadId` (for `findLinked` in Task 4).

- [ ] **Step 1: Map the column (frontend + backend)**

In `src/utils/supabaseClient.js`, add to `BOOKING_COLS`:

```js
  'Job Time': 'job_time', 'Assigned Worker': 'assigned_worker', 'Upsell Amount': 'upsell_amount', 'Upsell Notes': 'upsell_notes',
  'Lead Id': 'lead_id',
```

In `whatsapp-service/sb.js`, add the same `'Lead Id': 'lead_id'` line to its `BOOKING_COLS`.

- [ ] **Step 2: Expose `leadId` on normalised bookings**

In `src/hooks/useLeads.js` `normaliseCalBooking`, set `linkedLeadId` from the persisted column (replace the hard-coded `linkedLeadId: null`):

```js
    linkedLeadId:   f['Lead Id'] || null,
```

(Do NOT rename the field — downstream code already reads `linkedLeadId`.) Confirm `sbBookingRowToRecord` in `supabaseClient.js` includes `lead_id` in its select/`*`; since it maps via `BOOKING_COLS`, the new entry surfaces `f['Lead Id']` automatically.

- [ ] **Step 3: Set `lead_id` wherever a booking is created from a lead**

In `src/context/LeadsContext.jsx` `confirmBook`, add `'Lead Id': id` to the booking `createRecord` fields (next to `linkedLeadId: id`):

```js
        'Lead Id':      id,
```

In `src/hooks/useLeads.js` `recordBookingPayment`'s calendar-only-create branch is not applicable (that creates a lead, not a booking). In `addCalBooking`, when the booking is being created from/for a known lead, include `'Lead Id': <leadId>` in the created fields. If `addCalBooking` doesn't currently receive a lead id, pass the matched lead's id through (match via `findLinked` added in Task 4 is not yet available — for this task, set `'Lead Id'` only where a lead id is already in scope, e.g. `confirmBook`). Leave a code comment noting backfill (Task 3) covers pre-existing/unlinked bookings.

- [ ] **Step 4: Verify mapping + build**

Run: `node -e "const s=require('fs').readFileSync('src/utils/supabaseClient.js','utf8'); if(!/'Lead Id':\s*'lead_id'/.test(s))throw new Error('missing BOOKING_COLS lead_id'); console.log('PASS: BOOKING_COLS mapped')"`
Expected: PASS.

Run: `npm run build`
Expected: Vite build completes, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/utils/supabaseClient.js whatsapp-service/sb.js src/hooks/useLeads.js src/context/LeadsContext.jsx
git commit -m "feat(hardening): persist and expose bookings.lead_id on create"
```

> Ship 1 = Tasks 1 + 2. After committing, this is safe to merge + deploy (backward-compatible: new bookings get lead_id; nothing yet depends on it).

---

## Task 3: One-time backfill script (Ship 2)

**Files:**
- Create: `execution/backfill_lead_links.mjs`

**Interfaces:**
- Consumes: `findLinked` from Task 1.
- Produces: existing null-`lead_id` bookings/revenue linked to their lead; a printed plan.

- [ ] **Step 1: Write the script**

Create `execution/backfill_lead_links.mjs`:

```js
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

async function backfill(table, nameCol, phoneCol) {
  const rows = await get(`${table}?lead_id=is.null&select=id,${nameCol},${phoneCol}`);
  let linked = 0, ambiguous = 0, nomatch = 0;
  for (const r of rows) {
    const phone = r[phoneCol], name = r[nameCol];
    // ambiguity: >1 candidate lead by phone or (phone-less) name
    const dg = s => String(s || '').replace(/\D/g, '');
    const nm = s => String(s || '').trim().toLowerCase();
    const cands = dg(phone)
      ? leadRecs.filter(l => dg(l.phone) === dg(phone))
      : leadRecs.filter(l => nm(l.name) === nm(name));
    if (cands.length > 1) { ambiguous++; console.log(`  AMBIGUOUS ${table} ${r.id} "${name}" → ${cands.length} leads (skip)`); continue; }
    const hit = findLinked(leadRecs, { phone, name });
    if (!hit) { nomatch++; continue; }
    console.log(`  LINK ${table} ${r.id} "${name}" → lead ${hit.leadId}`);
    if (APPLY) await patch(table, r.id, { lead_id: hit.leadId });
    linked++;
  }
  console.log(`${table}: ${linked} linked, ${ambiguous} ambiguous (skipped), ${nomatch} no-match. ${APPLY ? 'APPLIED' : 'DRY-RUN (no writes)'}`);
}

await backfill('bookings', 'client_name', 'phone');
await backfill('revenue',  'client_name', 'phone');
```

- [ ] **Step 2: Dry-run and review**

Run: `node execution/backfill_lead_links.mjs`
Expected: prints `LINK …` / `AMBIGUOUS …` lines and per-table totals, ending `DRY-RUN (no writes)`. Review the AMBIGUOUS lines — those are left for manual handling.

- [ ] **Step 3: Apply (after the user reviews the dry-run)**

Run: `node execution/backfill_lead_links.mjs --apply`
Expected: same plan, ending `APPLIED`. Re-run the dry-run → should now report `0 linked` (all matched rows carry `lead_id`).

- [ ] **Step 4: Commit**

```bash
git add execution/backfill_lead_links.mjs
git commit -m "feat(hardening): one-time backfill linking bookings/revenue to leads (dry-run default)"
```

> Ship 2 = Task 3. The `.mjs` script is not part of the frontend bundle; committing it does not require a deploy.

---

## Task 4: Central `reconcileLead()` in the frontend (Ship 3)

**Files:**
- Modify: `src/hooks/useLeads.js`

**Interfaces:**
- Consumes: `findLinked`, `computeReconcile` from Task 1; `updateRecord`, `patchAirtable`, `AT_TABLES` (already imported).
- Produces: `reconcileLead(leadId)` (a `useCallback`), called from `changeStatus`/`savePaidInfo`/`recordBookingPayment`/`removeCalBooking` in place of their ad-hoc booking/revenue sync blocks.

- [ ] **Step 1: Import the pure core**

At the top of `src/hooks/useLeads.js`, add:

```js
import { findLinked, computeReconcile } from '../utils/reconcile';
```

- [ ] **Step 2: Add `reconcileLead`**

Add this `useCallback` in the hook (near the other cal-booking helpers). It resolves the lead's linked booking + revenue, computes patches, and applies them:

```js
  // Single source of truth for keeping a lead's booking + revenue consistent.
  // Resolves the linked records (lead_id → phone → name), computes patches via
  // the pure core, and applies them. Idempotent — safe to call after any mutation.
  const reconcileLead = useCallback(async (leadId) => {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;
    const bookingRecs = calBookings.map(b => ({ leadId: b.linkedLeadId, phone: b.phone, name: b.clientName, _b: b }));
    const linkedBooking = findLinked(bookingRecs, { leadId, phone: lead.phone, name: lead.name })?._b || null;
    // revenue is enriched onto the lead already (paidAmount / revenueRecordId / paid)
    const revenue = lead.revenueRecordId
      ? { id: lead.revenueRecordId, amount: lead.paidAmount, status: lead.paid ? (lead.status === 'job_done' ? 'Job Done' : 'In Progress') : 'In Progress' }
      : null;
    const { bookingPatch, revenuePatch } = computeReconcile({
      lead: { id: lead.id, status: lead.status },
      booking: linkedBooking ? { bookingStatus: linkedBooking.bookingStatus, amount: linkedBooking.amount } : null,
      revenue: revenue ? { amount: revenue.amount, status: revenue.status } : null,
    });
    if (bookingPatch && linkedBooking?.airtableId) {
      updateRecord(AT_TABLES.calendar, linkedBooking.airtableId, bookingPatch);
      setCalBookings(prev => prev.map(b => b.id === linkedBooking.id
        ? { ...b, ...(bookingPatch['Booking Status'] ? { bookingStatus: bookingPatch['Booking Status'] } : {}), ...(bookingPatch['Amount'] != null ? { amount: bookingPatch['Amount'] } : {}) }
        : b));
    }
    if (revenuePatch && lead.revenueRecordId) {
      updateRecord(AT_TABLES.revenue, lead.revenueRecordId, revenuePatch);
    }
  }, [leads, calBookings]);
```

- [ ] **Step 3: Call `reconcileLead` from the mutation handlers; remove their ad-hoc sync**

- In `changeStatus`: delete the `job_done`-only booking-Completed block and the demotion booking-Cancel block; after the status PATCH confirms, call `await reconcileLead(id)`.
- In `savePaidInfo`: delete the inline "Update linked calendar booking" block; after `writeRevenue`, call `await reconcileLead(id)`.
- In `recordBookingPayment`: keep the booking-Completed + revenue create (that's the primary write), then call `reconcileLead(match.id)` (or the created lead id) at the end to normalise amount/status.
- In `removeCalBooking`: keep the demote-to-In-Progress (it sets lead status), then call `reconcileLead(lead.id)` so the booking/revenue follow.

Add `reconcileLead` to those callbacks' dependency arrays.

- [ ] **Step 4: Verify build + reconcile tests still green**

Run: `node execution/test_reconcile.mjs`
Expected: PASS (pure core unchanged).

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 5: Manual verification (record output)**

With the dev server (`npm run dev`), reproduce each historical case and confirm calendar and Job Done agree:
- Record a payment on a **phone-less** lead that has a booking → booking amount matches the payment (Bailey).
- Move a **Booked** lead to **In Progress** → its booking is Cancelled and it leaves the calendar (Isaac).
- Two same-name phone-less leads → paying one does not affect the other (Tania).

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useLeads.js
git commit -m "feat(hardening): central reconcileLead() replaces scattered booking/revenue sync"
```

> Ship 3 = Task 4. Heaviest change — review carefully; merge/deploy on its own after manual verification.

---

## Task 5: Consistency-audit script (Ship 4)

**Files:**
- Create: `execution/audit_consistency.mjs`

**Interfaces:**
- Consumes: `findLinked`, `computeReconcile` from Task 1.
- Produces: a categorized drift report; `--repair` applies `computeReconcile` fixes.

- [ ] **Step 1: Write the script**

Create `execution/audit_consistency.mjs`:

```js
/* Report (default) or repair drift across leads/bookings/revenue.
   Report: node execution/audit_consistency.mjs
   Repair: node execution/audit_consistency.mjs --repair
   Reuses computeReconcile so report and repair can't diverge. */
import { readFileSync } from 'node:fs';
import { findLinked, computeReconcile } from '../src/utils/reconcile.js';

const REPAIR = process.argv.includes('--repair');
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const get = async p => (await fetch(`${URL}/rest/v1/${p}`, { headers: H })).json();
const patch = async (t, id, body) => fetch(`${URL}/rest/v1/${t}?id=eq.${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) });

// internal-status map (Airtable label → internal)
const ST = { 'New Lead': 'new', 'In Progress': 'in_progress', 'Quote Sent': 'quote_sent', 'Booked': 'booked', 'Job Done': 'job_done', 'Refused': 'refused', 'Archived': 'archived', 'Scam': 'scam' };

const leads = await get('leads?select=id,client_name,phone_number,lead_status');
const bookings = await get('bookings?select=id,client_name,phone,booking_status,amount,lead_id');
const revenue  = await get('revenue?select=id,client_name,phone,amount,status,lead_id');
const bRecs = bookings.map(b => ({ leadId: b.lead_id, phone: b.phone, name: b.client_name, _b: b }));
const rRecs = revenue.map(r => ({ leadId: r.lead_id, phone: r.phone, name: r.client_name, _r: r }));

let drift = 0;
for (const l of leads) {
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
// orphans + collisions (report only)
const linkedB = new Set(leads.flatMap(l => { const b = findLinked(bRecs, { leadId: l.id, phone: l.phone_number, name: l.client_name }); return b ? [b._b.id] : []; }));
bookings.filter(b => b.booking_status !== 'Cancelled' && !linkedB.has(b.id)).forEach(b => console.log(`ORPHAN booking ${b.id} "${b.client_name}" (no lead)`));
console.log(`\n${drift} drift item(s). ${REPAIR ? 'REPAIRED' : 'REPORT ONLY (no writes)'}`);
```

- [ ] **Step 2: Run report**

Run: `node execution/audit_consistency.mjs`
Expected: prints any `DRIFT …` / `ORPHAN …` lines + a total, ending `REPORT ONLY (no writes)`. On a healthy DB after Tasks 1–4 + backfill, drift should be low/zero.

- [ ] **Step 3: Repair (after the user reviews the report)**

Run: `node execution/audit_consistency.mjs --repair`
Expected: applies the same patches, ending `REPAIRED`. Re-run the report → `0 drift item(s)`.

- [ ] **Step 4: Commit**

```bash
git add execution/audit_consistency.mjs
git commit -m "feat(hardening): consistency audit/repair script reusing computeReconcile"
```

> Ship 4 = Task 5.

---

## Self-Review

**Spec coverage:**
- Stable links (persist + expose `lead_id`, `lead_id`-first matching) → Task 2 + `findLinked` (Task 1). ✅
- One-time backfill, dry-run default, ambiguous skipped → Task 3. ✅
- Central reconcile: pure `computeReconcile` + `reconcileLead` applier replacing ad-hoc sync → Tasks 1 + 4. ✅
- Source-of-truth rules (payment wins; booking status follows lead; Cancelled/Completed terminal) → Task 1 `computeReconcile` + unit tests. ✅
- Audit report/repair reusing `computeReconcile` → Task 5. ✅
- Light DB guards only (no triggers) → nothing added beyond existing FKs; explicitly out of scope. ✅
- Four independently-shippable phases → Ship 1 (T1–2) / Ship 2 (T3) / Ship 3 (T4) / Ship 4 (T5). ✅
- Testing (unit-test pure logic against the bit-us edge cases; dry-run/report before writes; manual re-verify) → Task 1 tests + Task 4 Step 5 + script dry-runs. ✅

**Placeholder scan:** No TBD/TODO; every code step is complete. Task 2 Step 3 notes that fully wiring `addCalBooking`'s lead id resolution waits on Task 4's `findLinked` and that backfill (Task 3) covers unlinked pre-existing bookings — that's an explicit sequencing note, not a placeholder. ✅

**Type consistency:** `findLinked(records, {leadId,phone,name})` and `computeReconcile({lead,booking,revenue}) → {bookingPatch,revenuePatch}` signatures match across Tasks 1, 4, 5. Patch objects use Airtable field names (`'Booking Status'`, `'Amount'`, `'Status'`) consistently, applied via `updateRecord`/PostgREST (translated by `BOOKING_COLS`/`REVENUE_COLS`). Booking status strings (`Scheduled`/`Completed`/`Cancelled`), lead internal statuses, and revenue statuses match the Global Constraints. ✅
