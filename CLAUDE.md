# Agent Instructions

> Mirrored across CLAUDE.md, AGENTS.md, GEMINI.md.

## Architecture: 3-Layer (Directive → Orchestration → Execution)

**Layer 1 — Directives** (`directives/`): Markdown SOPs defining goals, inputs, tools, outputs, edge cases.
**Layer 2 — Orchestration** (you): Read directives, call execution scripts in order, handle errors, update directives with learnings.
**Layer 3 — Execution** (`execution/`): Deterministic scripts (JS/Python). API calls, data transforms, DB writes. Env vars in `.env`.

**Why:** Each LLM step is ~90% accurate → 5 steps = 59%. Push deterministic work into scripts. You focus on routing and decisions.

## Operating Principles

1. **Check `execution/` first** before writing new scripts
2. **Never push to GitHub** without explicit user approval — build locally, show the user, wait for "push it"
3. **Self-anneal on failure:** read error → fix script → test → update directive → system is stronger
4. **Update directives** when you learn constraints (API limits, field names, timing). Don't create/overwrite without asking.
5. **Visual feedback loop:** When editing UI, use Playwright screenshots → `.tmp/screenshots/` → review → fix → re-screenshot → delete all screenshots when done. Never commit screenshots.

## File Organization

```
src/                    # React 18 + Vite frontend
  components/           # UI components + pages/
    BookingPage.jsx     # (superseded) public /book page — link now points to Cloud Run /book instead
  hooks/useLeads.js     # Central data hook (leads, bookings, clients, revenue)
  context/LeadsContext.jsx  # React Context wrapping useLeads
  utils/airtableSync.js    # fetchRecords, createRecord, updateRecord, deleteRecord
api/                    # Vercel serverless functions (fetch-records, create-record, etc.)
whatsapp-service/       # Cloud Run microservice (WhatsApp + invoicing + client rebooking)
  invoice.js            # multi-line + GST invoice PDF + HTML email (Gmail API)
  booking.js            # client rebooking: create Bookings row + .ics calendar invite
  booking-page.js       # standalone HTML booking page served at GET /book (off the dashboard domain)
  token.js              # HMAC-signed expiring booking tokens (BOOK_TOKEN_SECRET)
execution/              # Deterministic scripts (JS/Python)
  supabase_schema.sql           # Supabase DDL (run once in SQL Editor)
  migrate_airtable_to_supabase.cjs  # one-off data migration (--dry-run)
directives/             # Markdown SOPs
.tmp/                   # Disposable intermediate files + screenshots
.env                    # All API keys and env vars
```

---

## Project: Pearl View — Lead Generation & CRM Dashboard

### Business Context
**Client:** Pearl View — window cleaning services (Australia)
**Goal:** Centralized dashboard to manage inbound leads, bookings, clients, expenses, and revenue.

### Tech Stack (Production)
- **Frontend:** React 18 + Vite, deployed on **Vercel** (https://pearl-view-lead-generation.vercel.app). Deploy manually: `vercel --prod` (does NOT auto-deploy from git).
- **Database:** **Supabase Postgres** (project `jlbxvstjlcddnszquvvc`) — **LIVE since 2026-06-30** (migrated off Airtable; Airtable base `appNc7dQkFIq0dFFM` kept as read-only archive/fallback). Frontend reads/writes via `src/utils/supabaseClient.js` (gated by `VITE_USE_SUPABASE=true`); flip flags off to roll back to Airtable.
- **Auth:** **Username + password login** (Supabase Auth). Owner login `pearlview` (maps to `pearlview@pearlview.app`). `App.jsx` AuthGate; session JWT used for all DB calls; **RLS** restricts to authenticated. Backend uses `service_role` (bypasses RLS).
- **WhatsApp + Invoicing + Rebooking:** Cloud Run microservice (`whatsapp-service/`) on **GCP project `pearl-view-491114`**
- **Local dev:** `npm run dev` → http://localhost:5173/5174 (IS_LOCAL=true → direct Airtable calls)

### Airtable Tables
| Table | ID | Purpose |
|---|---|---|
| Leads | `tblS1keAU26CH08KJ` | Active leads |
| Old Leads | `tblgyzR61vgQnhOls` | Archived/migrated leads |
| Bookings | `tbl03PFKZTim2YLzq` | Calendar bookings |
| Revenue | (by name) | Payment records — source of truth for payment status |
| Expenses | (by name) | Business expenses |
| Clients | `tblvopuLt5afIpjDT` | Client profiles (synced from leads) |

### Lead Statuses
`new` → `in_progress` → `quote_sent` → `booked` → `job_done` / `refused` / `archived`

Airtable values: "New Lead", "In Progress", "Quote Sent", "Booked", "Job Done", "Refused", "Archived"

### Lead Sources
`website-pearlview`, `website-crystalpro`, `Phone Call`, `Facebook`, `Google`, `Other`

---

## WhatsApp Notification Service

**Location:** `whatsapp-service/` (Express.js, Docker, Cloud Run)
**GCP Project:** `pearl-view-491114` (account: `sandbox@optinetsolutions.com`)
**Meta Business Phone:** +63 924 120 3193 (Phone Number ID: `1038395276022233`, LIVE, name APPROVED)

### Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/webhook` | Meta webhook verification handshake |
| POST | `/webhook` | Incoming WhatsApp messages → AI reply (OpenAI gpt-4o-mini) |
| POST | `/notify-lead` | Dashboard calls this when new lead added → sends WhatsApp to owner |
| POST | `/send-invoice` | Dashboard "Send Invoice" → multi-line + GST PDF emailed from `pearlviewwindowcleaning@gmail.com` |
| GET | `/extract-emails` | Cron: ingest Gmail form/call leads → Airtable |
| GET | `/book` | Public client rebooking page (token `?t=`) — off the dashboard domain |
| GET | `/book-info` | Booking page bootstrap: signed token → client name, suggested date, booked dates |
| POST | `/book` | Client confirms a date → creates Bookings row + emails .ics calendar invite |

### Key Env Vars (`whatsapp-service/.env`)
- `WHATSAPP_TOKEN` — Meta system user token (never expires)
- `WHATSAPP_PHONE_NUMBER_ID` — `1038395276022233`
- `OWNER_PHONE` — `639684773879` (E.164, no +)
- `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, `AIRTABLE_TABLE_ID` — for AI context
- `OPENAI_API_KEY` — set in Cloud Run env (not in local .env)

### Deployment
**Live URL:** `https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app`
**Notify endpoint:** `https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app/notify-lead`

```bash
# 1. Auth FIRST — must be done interactively by the user in THEIR OWN PowerShell
#    (account has a reauth policy; non-interactive gcloud always fails reauth):
#      Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
#      $env:CLOUDSDK_PYTHON="C:\Users\User\AppData\Local\Python\bin\python3.exe"
#      gcloud auth login sandbox@optinetsolutions.com   # wait for "You are now logged in"
export CLOUDSDK_PYTHON="C:/Users/User/AppData/Local/Python/bin/python3.exe"

# 2. Deploy — uses the Dockerfile via --source, with --clear-base-image so code
#    changes actually take. Env vars PERSIST across deploys; only pass changed
#    ones via --update-env-vars (NOT --set-env-vars, which replaces all):
cd whatsapp-service
gcloud run deploy pearl-view-whatsapp --source . \
  --region asia-southeast1 --project pearl-view-491114 --clear-base-image \
  --update-env-vars "^@^KEY1=val1@KEY2=val2"   # custom @ delimiter for values w/ commas
```

After deploy, update `VITE_WEBHOOK_URL` in root `.env` with the new Cloud Run URL + `/notify-lead`.
Then redeploy the frontend separately: `vercel --prod` (after the user reviews locally).

### Template Status
- `pearl_view_notification` template: **NOT YET CREATED** on current WABA
- Service falls back to formatted plain text when template is missing
- Create template in Meta Business Manager > Message Templates when ready

---

## Critical Patterns & Gotchas

### Airtable Field Names (exact — typos are real)
- Address field is `Adress` (not "Address") — this is the actual Airtable column name
- `Lead Status` (not "Status"), `Client Name`, `Phone Number`, `Quote Amount`, `Final Invoice Amount`
- **Fields that DON'T exist on Leads table:** `Paid`, `Amount Paid`, `Payment Method`, `City`, `Lead Channel`
- Payment data lives in **Revenue table only** — enriched onto leads via phone number match

### Revenue Logic
- Job Done + Payment → Revenue `Status='Job Done'` → counts as income
- Payment without Job Done → Revenue `Status='In Progress'` → not income yet
- ReportsPage only counts Revenue with `Status='Job Done'` or blank as income

### React 18 Async Batching
- Never use `setLeads(fn)` to extract state values in async continuations — use `leads.find()` directly
- `changeStatus` reads lead via closure, not setter callback

### GCP Auth (non-interactive terminal)
- gcloud tokens expire. Re-auth via `execution/gcloud-login.bat` (double-click, opens browser flow)
- Always set `CLOUDSDK_PYTHON=C:\Users\User\AppData\Local\Python\bin\python3.exe` before gcloud commands

### Screenshots (Playwright)
- Use: `node .tmp/pw-test.cjs` with `require('C:/Users/User/Desktop/BannerScrapper/node_modules/playwright')`
- Or: `npx playwright screenshot --wait-for-timeout 8000 http://localhost:5173 path.png`
- Always delete screenshots from `.tmp/screenshots/` when done

---

## Supabase (LIVE — migrated off Airtable 2026-06-30)

Data layer is **Supabase Postgres** (project `jlbxvstjlcddnszquvvc`). Plan: `docs/superpowers/plans/2026-06-30-supabase-migration.md`. SQL scripts in `execution/supabase_*.sql`.

- **Schema:** 5 tables (`leads`/`revenue`/`bookings`/`clients`/`expenses`, snake_case + `airtable_id` trace col), `next_invoice_number()` fn, `leads_enriched` view (lateral-joins highest matching revenue by phone→name = payment enrichment in ONE query, `security_invoker`).
- **Frontend** (`src/utils/supabaseClient.js`): translation registry maps Airtable field names ↔ snake_case columns, so existing mutations/normalisers are unchanged. `airtableSync` + `useLeads.patchAirtable` delegate here when `VITE_USE_SUPABASE=true`. Record id = Supabase UUID. Uses the logged-in session JWT (`hdr()`); anon-key fallback.
- **Backend** (`whatsapp-service/sb.js`): invoice/booking/email-extractor use `service_role` when `USE_SUPABASE=true` (bypasses RLS). Invoice numbering → `next_invoice_number()` RPC.
- **Auth + RLS (Phase 7):** username/password (Supabase Auth, login `pearlview`→`pearlview@pearlview.app`). RLS enabled (`supabase_enable_rls.sql`): `pv_auth_all` policy → authenticated only; anon locked out; `service_role` bypasses.
- **Env:** `.env` + Vercel(VITE_*) + Cloud Run: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE` (server-only), `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_USE_SUPABASE=true` (Vercel), `USE_SUPABASE=true` (Cloud Run). Free tier (pauses after 7d idle, no auto-backups → Airtable archive is the fallback).
- **Rollback:** set `VITE_USE_SUPABASE`/`USE_SUPABASE` false → back to Airtable. **DDL** needs the SQL Editor; data writes use REST (session JWT or service_role).

## Invoicing & Rebooking (LIVE — `whatsapp-service`)

- **Invoices** (`invoice.js`): multi-line items + **GST 10% on top** (Subtotal/GST/Total), HTML email + plain-text fallback, PDF attached. Sender = **`pearlviewwindowcleaning@gmail.com`** (new OAuth client `432119928199-…`, `GMAIL_FORM_REFRESH_TOKEN`). Invoice email leads with the amount-due; a small "Book your next visit" link is secondary.
- **Client rebooking** (`booking.js` + `booking-page.js` + `token.js`): invoice → secure `?t=<signed token>` link → public `/book` page (served by Cloud Run, OFF the dashboard domain) → suggests +3mo (one-booking-per-day availability, blocks taken days) → confirm → creates a Bookings row (shows on dashboard) + emails an **auto-adding .ics** (METHOD:REQUEST). Env: `BOOK_TOKEN_SECRET`, `REBOOK_URL` (defaults to `SELF_BASE_URL`/book), `REBOOK_INTERVAL_MONTHS` (3).
- **Multi-select Job Type** (`useLeads.saveJobType`, DetailPanel chips): writes primary to `Property Type` + array to a **`Services` multiple-select field that must be created in Airtable** (Leads table). Write is resilient (best-effort `Services` patch) so it's safe before the field exists — but multiple values won't persist until you add it.

## Recent Changes — 2026-06-30
Multi-line + GST invoices · new Gmail sender · invoice email redesigned (invoice-first) · client rebooking + .ics + secure token + off-domain booking page · multi-select Job Type (needs Airtable `Services` field) · InvoiceModal email-wipe bug fixed (effect keyed on `lead?.id`) · `vercel.json` SPA rewrite for `/book` · Supabase project + schema + data migration (Phases 1-2). All invoicing/rebooking deployed to Cloud Run; frontend deployed to Vercel.
