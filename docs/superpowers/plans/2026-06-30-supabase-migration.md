# Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each phase task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Pearl View's entire data layer from Airtable to Supabase (Postgres) to fix slow loads and remove Airtable's rate limits, migrating all existing data with no loss.

**Architecture:** Keep the existing `useLeads`/`LeadsContext` API surface unchanged so React components don't change. Underneath, replace `airtableSync.js` with a `supabaseClient.js` data layer. Replace the `/api/*` Airtable proxies and the `whatsapp-service` Airtable calls with Supabase queries. A single indexed query (with a SQL view that joins payments onto leads) replaces today's multi-round-trip, client-side-join load.

**Tech Stack:** React 18 + Vite (unchanged), `@supabase/supabase-js`, Supabase Postgres + (optional) Supabase Auth, Vercel (frontend + `/api`), Cloud Run (`whatsapp-service`).

## Global Constraints

- **Preserve the `useLeads` return shape and `LeadsContext` API exactly** — components consume `leads`, `clients`, `calBookings`, `deletedLeads`, and all mutation fns (`changeStatus`, `savePaidInfo`, `addCalBooking`, `recordBookingPayment`, `saveJobType`, etc.). Internals change; signatures do not.
- **No data loss.** Every existing Airtable record (Leads incl. Old Leads, Revenue, Bookings, Clients, Expenses) migrates.
- **Keep independent subsystems untouched:** Mobile Message (`/api/mm-*`), WhatsApp transport (Green-API/Meta). Only the Airtable data access changes.
- **Field-name parity:** internal JS keys (`jobType`, `jobTypes`, `paid`, `paidAmount`, `invoiceNumber`, `invoiceSent`, address as `address`, etc.) stay the same; only the storage layer's column names change to snake_case.
- **Phased cutover.** Each phase leaves the app working. Airtable stays the live source until Phase 6 cutover.
- **Invoice numbering must remain monotonic** continuing from the current max (floor `INVOICE_START=210`).

---

## Key Decisions (locked unless flagged ⚠️)

1. **Schema:** 5 tables — `leads`, `revenue`, `bookings`, `clients`, `expenses`. Drop unused `Refused`. snake_case columns, real types (numeric, date, timestamptz, boolean, text[]).
2. **Primary keys:** Supabase `uuid` PKs. The frontend's `airtableId` concept maps to the row `id`. A migration-time mapping table (`_airtable_map`) records old `recXXX` → new `uuid` so cross-table links (bookings↔leads, revenue↔leads) resolve correctly.
3. **Booking↔lead link:** add a real `lead_id uuid references leads(id)` FK on `bookings` — this **fixes** the current "linkedLeadId is null on reload" hack (today it falls back to phone/name).
4. **Payments:** keep `revenue` as a separate table (source of truth, preserves all payment logic). A SQL **view `leads_enriched`** left-joins the highest-amount revenue row by phone (name fallback for phone-less leads), reproducing today's enrichment in one query server-side.
5. **Invoice numbering:** dedicated `leads.invoice_number int` + a Postgres function `next_invoice_number()` using `max(invoice_number, 209)+1` in a transaction (replaces the full-table scan).
6. **Data access from frontend:** ⚠️ **SECURITY DECISION NEEDED** — three options in the "Open Decision" section below. Default recommendation: **add a Supabase Auth login gate** (the app is currently fully public) and use the `anon` key with RLS. Until decided, Phase 1-2 proceed unaffected.
7. **Dev/prod split:** `IS_LOCAL` distinction largely disappears — the Supabase client works the same locally and in prod (the `anon` key is safe to ship when RLS is on). `/api/*` Airtable proxies are removed.

## ⚠️ Open Decision — frontend security model (needed before Phase 3)

- **A. Supabase Auth login gate (recommended).** Add a real login (the app is public today). Frontend uses `anon` key; RLS policies require an authenticated session. Most secure; adds a login screen.
- **B. Service-role behind `/api` proxy.** Keep `/api/*` functions, swap them to Supabase using the `service_role` key (server-only). Frontend stays keyless. No login, but app stays public to anyone with the URL (same as today).
- **C. Anon key, permissive RLS.** Simplest, but the `anon` key in the bundle could read/write data. Not recommended.

---

## Target Schema (Phase 1 deliverable)

```sql
-- leads
create table leads (
  id uuid primary key default gen_random_uuid(),
  client_name text,
  phone_number text,
  caller_id text,
  email text,
  lead_source text,
  call_lead_source text,
  lead_status text not null default 'New Lead',
  call_time timestamptz,
  call_recording_transcript text,
  inquiry_date timestamptz,
  inquiry_subject text,
  service_address text,
  address text,                       -- maps the 'Adress' (sic) field
  property_type text,                 -- primary job type (single)
  services text[] default '{}',       -- multi-select job types
  estimated_window_count int,
  stories int,
  quote_amount numeric,
  final_invoice_amount numeric,
  call_duration text,
  next_follow_up_date date,
  scheduled_cleaning_date date,
  property_details text,
  notes text,
  refusal_reason text,
  city text,
  invoice_number int,
  invoice_sent boolean default false,
  created_at timestamptz default now()
);
create index on leads (phone_number);
create index on leads (lead_status);

-- revenue (payment source of truth)
create table revenue (
  id uuid primary key default gen_random_uuid(),
  revenue_name text, date date, client_name text, phone text,
  job_service text, city text, payment_method text,
  amount numeric, status text, lead_id uuid references leads(id),
  created_at timestamptz default now()
);
create index on revenue (phone);

-- bookings
create table bookings (
  id uuid primary key default gen_random_uuid(),
  booking_name text, client_name text, phone text, city text,
  job_service text, date timestamptz, booking_status text,
  amount numeric, job_time text, assigned_worker text,
  upsell_amount numeric, upsell_notes text,
  lead_id uuid references leads(id),   -- fixes the null-on-reload link
  created_at timestamptz default now()
);

-- clients
create table clients (
  id uuid primary key default gen_random_uuid(),
  client_name text, phone_number text, email text, address text,
  city text, notes text, property_type text, lead_source text,
  status text, created_at timestamptz default now()
);
create index on clients (phone_number);

-- expenses
create table expenses (
  id uuid primary key default gen_random_uuid(),
  expense_name text, date date, category text,
  amount numeric, description text, created_at timestamptz default now()
);

-- enrichment view: leads + highest-amount matching revenue
create view leads_enriched as
select l.*,
  r.amount       as paid_amount,
  r.payment_method as payment_method,
  (r.id is not null) as paid,
  r.id           as revenue_record_id
from leads l
left join lateral (
  select * from revenue r
  where r.amount > 0
    and ( (l.phone_number <> '' and regexp_replace(r.phone,'\s','','g') = regexp_replace(l.phone_number,'\s','','g'))
       or (coalesce(l.phone_number,'') = '' and lower(r.client_name) = lower(l.client_name)) )
  order by r.amount desc limit 1
) r on true;
```

---

## Phases (each leaves the app working)

### Phase 0 — Prerequisites
- [ ] Create Supabase project (or obtain existing). Capture `Project URL`, `anon` key, `service_role` key.
- [ ] Add to `.env`: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (and `SUPABASE_SERVICE_ROLE` server-side if Option B).
- [ ] `npm i @supabase/supabase-js`.

### Phase 1 — Schema
- [ ] Run the SQL above in Supabase SQL editor (tables + indexes + `next_invoice_number()` fn + `leads_enriched` view).
- [ ] Verify with a manual insert + `select * from leads_enriched`.

### Phase 2 — Data migration (one-off script)
- [ ] `execution/migrate_airtable_to_supabase.cjs`: read every Airtable table (paginated) → map field names → insert into Supabase, recording `recXXX → uuid` in `_airtable_map`.
- [ ] Second pass: resolve `bookings.lead_id` / `revenue.lead_id` from the map (by stored Airtable links, else phone, else name).
- [ ] `--dry-run` mode prints counts; verify row counts match Airtable before the real run.
- [ ] Validation query: counts per table + spot-check 10 enriched leads vs Airtable.

### Phase 3 — Frontend READ path
- [ ] Create `src/utils/supabaseClient.js` (client init + `fetchAll(table)` etc.).
- [ ] Rewrite `useLeads.fetchLeads` to `select * from leads_enriched` + parallel `bookings`/`clients` in ONE Supabase round-trip (no client-side payment join).
- [ ] Map snake_case rows → existing JS keys in the normalisers.
- [ ] Verify load time drop and data parity against Airtable. (Decision A/B/C must be set here.)

### Phase 4 — Frontend WRITE path
- [ ] Reimplement `createRecord`/`updateRecord`/`deleteRecord` equivalents against Supabase.
- [ ] Port each mutation: `changeStatus`, `saveNote`, `renameLead`, `setRefuseReason`, `savePaidInfo` (revenue insert), `saveJobType` (property_type + services[]), `saveJobDate`, `saveEmail`, `saveQuoteAmount`, `clearQuoteAmount`, `deletePayment`, `archiveLead`, `permanentDelete`, `recoverLead`, `addLead`, client sync (`syncToClients`/`upsertClient`/`syncClientsFromLeads`/`updateClient`), `addCalBooking`, `removeCalBooking`, `updateCalBooking`, `recordBookingPayment`, expenses CRUD.
- [ ] Replace booking↔lead phone/name matching with the real `lead_id` FK.
- [ ] Re-verify the payment scenarios (S1/S2/S3) and calendar⇄booked sync.

### Phase 5 — Backend (`whatsapp-service`)
- [ ] `invoice.js`: `fetchLeadById` → Supabase select; `computeNextInvoiceNumber` → `next_invoice_number()` RPC; `markLeadInvoiced` → update.
- [ ] `email-extractor.js`: `findExistingLead` dedup → Supabase query; `writeLeadToAirtable` → Supabase insert.
- [ ] `airtable.js` (`getLeadsContext` for AI) → Supabase aggregate query.
- [ ] Swap env vars; redeploy Cloud Run.

### Phase 6 — Cutover + cleanup
- [ ] Final data re-sync (migrate any records created in Airtable since Phase 2).
- [ ] Remove `airtableSync.js`, `/api/*` Airtable proxies (keep `mm-*`), Airtable env vars.
- [ ] Deploy frontend (Vercel) + backend (Cloud Run). Smoke-test end to end.

### Phase 7 (optional) — Auth gate
- [ ] If Decision A: add Supabase Auth login screen + RLS policies + route guard in `App.jsx`.

---

## Self-Review notes
- **Coverage:** every Airtable table, every mutation fn, both serverless and Cloud Run touchpoints, invoice numbering, payment enrichment, and the booking-link hack are addressed.
- **Risk:** Phase 4 is the largest; the `useLeads` API contract is the safety net (components untouched). Phases run behind the live Airtable until Phase 6.
- **Detailed steps:** each phase will be expanded into bite-sized TDD tasks at execution time (this master plan locks architecture + sequencing).
