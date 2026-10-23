# Automatic Calendar Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the office books a job for a client with an email, the client automatically gets a Google Calendar invitation from Pearlview that moves when the job is rescheduled and disappears when it is cancelled.

**Architecture:** A Postgres trigger flags bookings whose invite-relevant fields change (bumping a revision counter). A Cloud Run job (`POST /run-calendar-sync`, Cloud Scheduler every 5 min) reads flagged bookings, decides create / update / cancel with a pure, unit-tested core, and calls the Google Calendar API (`sendUpdates:'all'`) from the Pearlview Gmail account's primary calendar, storing the event id on the booking. The dashboard only writes bookings (plus new email + date editing and a "time required" rule) and shows an invite status.

**Tech Stack:** Node 20 CommonJS (`whatsapp-service`, googleapis Calendar v3, `node:test`), Supabase Postgres + PostgREST + RLS, React 18 + Vite (ESM; frontend tests = plain node scripts in `execution/`), Cloud Run + Cloud Scheduler.

**Spec:** `docs/superpowers/specs/2026-10-23-calendar-invites-design.md`

## Global Constraints

- No new npm dependencies. Backend tests: `node --test <file>` from `whatsapp-service/`. Frontend pure-logic tests: `node execution/<name>.mjs` (pattern: `execution/test_fetch_all_pages.mjs`).
- Feature ships **OFF** (`calendar_invite_settings.enabled=false`, `test_mode=true`). Test mode: only bookings whose client name starts with `TEST` (word) are processed, and the attendee is replaced by the test email.
- Invitations only for bookings that are `Scheduled`, dated **today or later** (business time zone), have a job time and a valid email.
- Event: title `${service || 'Window Cleaning'} — ${BRAND_SHORT}`; **120 minutes**; time zone = `config.TZ` (`BUSINESS_TZ`, NSW default `Australia/Sydney`); location = service address, else city; reminders `{ useDefault: true }`; `sendUpdates: 'all'`; calendar `primary` of the account behind `GMAIL_SEND_REFRESH_TOKEN || GMAIL_FORM_REFRESH_TOKEN`.
- Event description (exact copy):
  `Your window clean with ${BRAND_SHORT}.\nService: ${service}\nNeed to change it? Reply to this invitation or contact us on ${BUSINESS.phone} / ${BUSINESS.email}.`
- `gcal_status` values (exact): `legacy`, `pending`, `sending`, `sent`, `emailed_ics`, `no_email`, `needs_time`, `failed`, `cancelled`.
- Existing bookings at install are `legacy` and are **never** synced. Bookings that already have an event id are always kept in step (update/cancel) even when the feature is switched off — never create when off.
- Retry back-off after a failed Google call: 15 min, 1 h, 4 h, then `failed` (5th failure); any later edit re-queues.
- Endpoint auth: header `x-cron-secret` = env `CRON_SECRET` (already set on Cloud Run). Scheduler job `pearl-view-calendar-sync`, location `asia-southeast1`, `*/5 * * * *`, time zone `Australia/Sydney`.
- Office UI: "require a time" whenever the booking has a client email — message exactly `Add a time — the client gets a calendar invitation.`
- DDL runs only in the Supabase SQL Editor (NSW project `zagmrxxmhyprhnhucqpo`) — the user runs it. Never push or deploy without the user's explicit "push it"; Cloud Run deploy needs the user's interactive `gcloud auth login` first and uses `--update-env-vars` only if a var changes.
- Commit only the files a task touches (never `git add -A`). PMS board entries are written for non-technical readers (see CLAUDE.md "Write PMS tasks for a non-technical reader").

## Review Focus

1. **Office edits a booking while the job is mid-sync** → the edit must not be lost (the job may only clear the flag if the booking's revision is unchanged). Test: Task 2 `keeps the flag when the booking changed mid-sync`; Task 4 verifier step 4.
2. **Feature switched off after invites went out, then the job is cancelled/moved** → the client's event is still cancelled/moved. Test: Task 1 `planSync cancels/updates an existing event even when disabled`; Task 4 verifier step 5.
3. **The event was deleted by hand in Google Calendar** → cancelling counts as done; updating recreates it instead of failing forever. Test: Task 2 `404 on cancel is success` and `404 on update recreates`.
4. **Times typed in odd shapes** (`12:30 PM`, `12:00 AM`, `2:30pm`, `14:30`, `9:00`, ` `) → correct 24-hour time or "needs a time", never a wrong time. Test: Task 1 `parseJobTime`.
5. **Booking moved to a past date, or email removed after an invite was sent** → no new invite for past dates; removing the email cancels the existing event. Test: Task 1 `planSync` cases `past date` and `email removed after sending`.

---

### Task 1: Pure calendar decisions (`calendar-core.js`)

**Files:**
- Create: `whatsapp-service/calendar-core.js`
- Test: `whatsapp-service/calendar-core.test.js`

**Interfaces:**
- Consumes: `cleanEmail`, `isTestLead` from `whatsapp-service/followup-core.js` (reuse — do not copy).
- Produces (CommonJS):
  - `EVENT_MINUTES = 120`, `BACKOFF_MINUTES = [15, 60, 240]`, `MAX_FAILS = 5`
  - `parseJobTime(str) → 'HH:MM' | null`
  - `planSync(booking, settings, todayYmd) → { type: 'create'|'update'|'cancel'|'noop'|'hold'|'no_email'|'needs_time'|'past', attendee?: string }` — `booking` is a raw `bookings` row (snake_case: `client_name, client_email, date, job_time, booking_status, job_service, service_address, city, gcal_event_id, gcal_attendee`); `settings` = `{ enabled, test_mode, test_email }`.
  - `buildEvent(booking, { tz, brandShort, businessEmail, businessPhone, attendee }) → Google Calendar requestBody`
  - `afterSuccess(type, now, eventId, attendee) → snake_case column patch` (type `create`|`update`|`cancel`); `afterSkip(type) → patch` for `no_email` → `{gcal_status:'no_email'}`, `needs_time` → `{gcal_status:'needs_time'}`, `noop`/`past` → `{}` — every skip patch also carries `gcal_sync_needed:false, gcal_next_at:null`; `afterFailure(booking, now) → patch` (uses `gcal_fail_count`). `hold` writes nothing.

- [ ] **Step 1: Write the failing tests** (`calendar-core.test.js`, `node:test` + `node:assert/strict`). Pin at least:
  - `parseJobTime`: `'9:00 AM'→'09:00'`, `'12:30 PM'→'12:30'`, `'12:00 AM'→'00:00'`, `'2:30pm'→'14:30'`, `'14:30'→'14:30'`, `'9:00'→'09:00'`, `''`/`null`/`'  '`/`'soon'`/`'25:00'`/`'9:75 AM'`→`null`.
  - `planSync`, base booking `{ client_name:'Jane', client_email:'jane@x.com', date:'2026-11-06', job_time:'9:00 AM', booking_status:'Scheduled', gcal_event_id:null }`, `today='2026-10-23'`, settings `{enabled:true, test_mode:false}`:
    - no event → `{type:'create', attendee:'jane@x.com'}`; with `gcal_event_id:'e1', gcal_attendee:'jane@x.com'` → `update`;
    - `booking_status:'Cancelled'` + event → `cancel`; Cancelled without event → `noop`; `Completed` → `noop`;
    - `date:'2026-10-22'` without event → `past`; past date **with** event + Cancelled → `cancel`;
    - `job_time:''` → `needs_time`; `client_email:''` → `no_email`; `client_email:'Jane <jane@x.com>'` → attendee `jane@x.com`;
    - email removed after sending (`client_email:''`, `gcal_event_id:'e1'`) → `cancel`;
    - **disabled** (`enabled:false`): no event → `noop`; with event → `update` / `cancel` as normal ("cancels/updates an existing event even when disabled");
    - test mode: `client_name:'Jane'` → `hold`; `client_name:'TEST Jane'` + `test_email:'owner@x.com'` → create with `attendee:'owner@x.com'`; test mode + blank `test_email` → `hold`.
  - `buildEvent`: summary `'Window Cleaning — Pearl View'` when `job_service` blank; `start.dateTime '2026-11-06T09:00:00'`, `end.dateTime '2026-11-06T11:00:00'`, both `timeZone 'Australia/Sydney'`; location falls back to city; description equals the Global Constraints copy; `attendees:[{email, displayName:'Jane'}]`; `reminders:{useDefault:true}`; a 23:00 start ends `'2026-11-07T01:00:00'` (crosses midnight correctly).
  - `afterSuccess('create', now, 'e9', 'jane@x.com')` → `{ gcal_event_id:'e9', gcal_status:'sent', gcal_attendee:'jane@x.com', gcal_sync_needed:false, gcal_fail_count:0, gcal_next_at:null, gcal_synced_at:now.toISOString() }`; `'cancel'` → `{ gcal_status:'cancelled', gcal_event_id:null, gcal_attendee:null, … }`; `afterSkip('no_email')` → `{ gcal_status:'no_email', gcal_sync_needed:false, gcal_next_at:null }`; `afterSkip('past')` → `{ gcal_sync_needed:false, gcal_next_at:null }`.
  - `afterFailure`: fail 1→`gcal_next_at` +15 min; 2→+60; 3→+240; 4→+240; 5th → `{ gcal_status:'failed', gcal_sync_needed:false }`.

- [ ] **Step 2: Run** `cd whatsapp-service && node --test calendar-core.test.js` — expected FAIL (`Cannot find module './calendar-core'`).

- [ ] **Step 3: Implement** the module. `parseJobTime` accepts `H:MM` with optional `AM/PM` (any case, optional space); rejects hour/minute out of range. `planSync` order: Completed → noop; Cancelled → cancel if event else noop; email missing → cancel if event else no_email; test-mode hold (non-TEST name, or no valid test email) — but only for creates (an existing event is always kept in step); no time → needs_time; date < today → past (or cancel/noop per above); disabled and no event → noop; event → update; else create. `buildEvent` computes end by adding minutes to a local date-time (no Date/time-zone conversion — keep wall-clock strings).

- [ ] **Step 4: Run** the test file — expected PASS, output pristine. Also `node --test followup-core.test.js followup.test.js` still passes (41).

- [ ] **Step 5: Commit** `feat(calendar): pure invite decisions (time parsing, plan, event body)`.

---

### Task 2: Sync job, data access and endpoint

**Files:**
- Create: `whatsapp-service/calendar-sync.js`, `whatsapp-service/calendar-sync.test.js`
- Modify: `whatsapp-service/sb.js` (add 4 functions + exports), `whatsapp-service/index.js` (route above `// ─── Start server`)

**Interfaces:**
- Consumes: Task 1 exports; `config.{TZ, BRAND_SHORT, BUSINESS}`; the existing `oauthClient()` pattern in `booking.js` (export it from `booking.js` rather than copying).
- Produces:
  - `sb.getCalendarInviteSettings() → row|null` (404 → null), `sb.fetchBookingsToSync({ nowIso, limit }) → rows` (`gcal_sync_needed=eq.true` and (`gcal_next_at` null or ≤ now), ordered by `gcal_next_at` nulls first, limit 25), `sb.claimBookingSync(id, rev, now, leaseMin) → bool` (conditional PATCH setting `gcal_next_at` lease where `gcal_rev=eq.rev` and still flagged), `sb.finishBookingSync(id, rev, patch) → bool` (PATCH where `gcal_rev=eq.rev`; the patch includes `gcal_sync_needed:false`).
  - `runCalendarSync({ dry?, probe?, now?, deps? }) → { skipped } | { dry, enabled, testMode, due, created, updated, cancelled, held, skipped, errors, actions[] }`; with `probe:true` returns `{ probe: 'ok' | <error message> }` after a `calendarList.get('primary')` call.
  - `deps`: `{ getSettings, fetchDue, claim, finish, insertEvent(body)→id, patchEvent(id, body), deleteEvent(id) }` — Google calls via `google.calendar({version:'v3'}).events.{insert,patch,delete}` with `calendarId:'primary'`, `sendUpdates:'all'`, `{ timeout: 30000 }`.
  - `POST /run-calendar-sync[?dry=true|?probe=true]`, `x-cron-secret` required (401 otherwise), same shape as `/run-followups`.

- [ ] **Step 1: Write failing tests** (`calendar-sync.test.js`, fake deps like `followup.test.js`): `creates and stores the event id`; `updates an existing event`; `cancels and clears the event id`; `holds real bookings in test mode without claiming`; `a lost claim does nothing`; **`keeps the flag when the booking changed mid-sync`** (`finish` returns false → no error, counted as `requeued`); **`404 on cancel is success`**; **`404 on update recreates`** (insert called, new id stored); `a Google failure backs off`; `dry run claims and calls nothing`; `disabled still processes rows with an event id`; `probe reports ok / the error`.
- [ ] **Step 2: Run** `node --test calendar-sync.test.js` — FAIL (module missing).
- [ ] **Step 3: Implement** `calendar-sync.js` (all I/O through `deps`; `realDeps` wired to `sb` + Google) and the four `sb.js` functions; add the route to `index.js`.
- [ ] **Step 4: Run** `node --test calendar-core.test.js calendar-sync.test.js followup-core.test.js followup.test.js` — all PASS; module load check (without starting the server): `node -e "require('./calendar-sync'); require('./booking')"` prints nothing and exits 0.
- [ ] **Step 5: Commit** `feat(calendar): sync job + secret-protected /run-calendar-sync`.

---

### Task 3: Self-rebook joins the system + time-zone fix

**Files:**
- Modify: `whatsapp-service/booking.js` (`createCalendarInvite`, `buildGcalUrl`, `createRebooking`), `whatsapp-service/sb.js` (`BOOKING_COLS` gains the new columns)

**Interfaces:**
- Consumes: Task 1 `buildEvent`; Task 4 column names.
- Produces: `createCalendarInvite(booking-like args) → { id }` built with `buildEvent` (120 min, `config.TZ`); `createRebooking` inserts the booking with `Client Email`, `Invite Status:'sending'`, then on success writes `Calendar Event Id`, `Invite Status:'sent'`, `Invite Attendee`; on the `.ics` fallback writes `Invite Status:'emailed_ics'`. `buildGcalUrl` uses `config.TZ`. `sb.js BOOKING_COLS` adds `'Client Email':'client_email'`, `'Calendar Event Id':'gcal_event_id'`, `'Invite Status':'gcal_status'`, `'Invite Attendee':'gcal_attendee'`.

**Deploy-order guard:** these writes target columns created in Task 4. This code must not reach Cloud Run before the Task 4 SQL is applied (otherwise client self-booking would fail). Task 8 enforces the order.

- [ ] **Step 1: Verify first (RED):** `node -e "const b=require('./booking'); console.log(b.buildGcalUrl({svc:'Window Cleaning',date:'2026-11-06',timeStr:'09:00'}).includes('Australia%2FSydney'))"` → prints `false` today (Brisbane default).
- [ ] **Step 2: Implement** the booking.js changes (no new harness for `createRebooking`; it has no DI — keep the change small and route event building through `buildEvent`).
- [ ] **Step 3: Verify (GREEN):** the same command prints `true`; `node -e "console.log(typeof require('./booking').createRebooking)"` → `function`; all backend tests PASS.
- [ ] **Step 4: Commit** `feat(calendar): self-rebook stores its event + uses business time zone`.

---

### Task 4: Database — columns, settings, trigger (user runs it)

**Files:**
- Create: `execution/supabase_calendar_invites.sql`, `execution/test_calendar_trigger.mjs`

**Interfaces:**
- Produces: `bookings` columns `client_email text, gcal_event_id text, gcal_status text, gcal_attendee text, gcal_sync_needed boolean not null default false, gcal_rev int not null default 0, gcal_fail_count int not null default 0, gcal_next_at timestamptz, gcal_synced_at timestamptz`; index on `(gcal_sync_needed, gcal_next_at)`; table `calendar_invite_settings` (single row `id=1`: `enabled false`, `test_mode true`, `test_email text`, `updated_at`), owner-only RLS via `is_owner()` (same pattern as `followup_settings`); trigger `bookings_gcal_mark` (BEFORE INSERT OR UPDATE, `SECURITY DEFINER`, `search_path = public, pg_temp`).

Trigger rules (exact):
- Migration first runs `update bookings set gcal_status='legacy'` for **all existing rows** (before the trigger exists).
- `legacy` rows are never flagged.
- INSERT: if `gcal_status` is supplied (`sending` from self-rebook) leave it; otherwise if settings enabled → `gcal_status='pending', gcal_sync_needed=true, gcal_rev=1`.
- UPDATE where any of `date, job_time, booking_status, job_service, service_address, city, client_email, client_name` changed (IS DISTINCT FROM) and the row is not `legacy`: flag (`gcal_sync_needed=true, gcal_rev=old+1, gcal_fail_count=0, gcal_next_at=null`) **if** settings enabled **or** `gcal_event_id is not null`.
- Updates touching only `gcal_*` columns never re-flag (the job's own writes).
- A missing settings row behaves as disabled; never raise.

- [ ] **Step 1: Write** the SQL (one transaction, `set local lock_timeout = '5s'`, re-runnable) and the verifier script modelled on `execution/test_followup_trigger.mjs` (asserts: legacy rows untouched by edits; insert while enabled → pending/flag/rev 1; relevant edit bumps rev; `gcal_*`-only edit does not; disabled + event id → still flagged on edit; disabled + no event → not flagged; `sending` insert left alone; a `finishBookingSync`-style conditional PATCH with a stale rev updates 0 rows. Restores `enabled` FIRST in `finally`, refuses to run unless `test_mode` is true, deletes its `TEST Calendar …` bookings).
- [ ] **Step 2: Run** `node --env-file=.env execution/test_calendar_trigger.mjs` → FAIL (404 on `calendar_invite_settings`) before the SQL exists.
- [ ] **Step 3: Ask the user** to run `execution/supabase_calendar_invites.sql` in the Supabase SQL Editor; wait for "Success".
- [ ] **Step 4: Run** the verifier → `PASS`; confirm leftover test bookings = 0 and `enabled=false`.
- [ ] **Step 5: Commit** `feat(calendar): booking invite columns, settings, sync trigger`.

---

### Task 5: Dashboard data layer

**Files:**
- Modify: `src/utils/supabaseClient.js` (`BOOKING_COLS`, `sbBookingRowToRecord`, settings helpers), `src/hooks/useLeads.js` (`normaliseCalBooking`, `addCalBooking`, `updateCalBooking`), `src/context/LeadsContext.jsx` (`confirmBook` passes `email: lead.email`; load + expose `inviteSettings`/`setInviteSettings`)

**Interfaces:**
- Consumes: Task 4 columns.
- Produces: frontend field names `'Client Email'`, `'Invite Status'` (read-only in the UI); booking objects gain `email` (from `Client Email`, replacing the hard-coded `''`) and `inviteStatus`; `updateCalBooking(id, { date, email, … })` maps `date → 'Date'`, `email → 'Client Email'`; when `date` changes on a booking with `linkedLeadId`, the lead's `Scheduled Cleaning Date` is updated too (existing `saveJobDate`-style patch); `fetchInviteSettings()` / `saveInviteSettings(patch)` mirroring the follow-up helpers (null on missing table; save throws on HTTP error, returns null on 0-row match).

- [ ] **Step 1:** `npm run build` passes after the edits; `node execution/test_fetch_all_pages.mjs` and `node execution/test_followup_template.mjs` still PASS.
- [ ] **Step 2:** Live read check (service role): `bookings?select=client_email,gcal_status&limit=1` returns the columns (proves the mapping targets real columns).
- [ ] **Step 3: Commit** `feat(calendar): bookings carry client email + invite status; date editable in data layer`.

---

### Task 6: Booking forms — email, date editing, "require a time", status pill

**Files:**
- Create: `src/utils/inviteRules.js`, `execution/test_invite_rules.mjs`
- Modify: `src/components/BookModal.jsx`, `src/components/pages/CalendarPage.jsx` (`AppointmentFormFields`, `BookingModal` New Appointment, `EditBookingModal`)

**Interfaces:**
- Consumes: Task 5 (`booking.email`, `booking.inviteStatus`, `updateCalBooking` date/email, `inviteSettings`).
- Produces (ESM, pure): `timeRequired(email, jobTime) → string | ''` (returns the Global Constraints message when the email is valid and the time is blank/unparseable; reuse the same parsing rules as `parseJobTime` — copy is acceptable only with a parity assertion against `whatsapp-service/calendar-core.js` via `createRequire`, as `execution/test_followup_template.mjs` does); `inviteStatusLabel(booking, settings) → { text, tone } | null` (`sent`→"📅 Invite sent", `pending`/`sending`→"Invite queued", `no_email`→"No email", `needs_time`→"Needs a time", `failed`→"Invite failed — check the email", `emailed_ics`→"Invite emailed", `cancelled`→null, `legacy`/null → null; null when settings are null).

- [ ] **Step 1: Write failing tests** `execution/test_invite_rules.mjs` (all cases above + parity of time parsing with the backend).
- [ ] **Step 2: Run** → FAIL; **Step 3:** implement `inviteRules.js`; run → PASS.
- [ ] **Step 4: UI wiring:**
  - BookModal: when the lead has an email, label "Job Time" with a red `*` and block submit with `timeRequired(...)`.
  - New Appointment: add an optional **Email** field (pre-filled when a client/lead suggestion is picked — add `email` to the suggestion items), pass `email` to `addCalBooking`, block with `timeRequired`.
  - EditBookingModal: add **Date** (`<input type="date">`) and **Email** fields; save passes `date` and `email`; block with `timeRequired`; show `inviteStatusLabel` as a small pill under the header (owner only, hidden in `readOnly`).
- [ ] **Step 5: Verify** `npm run build`; browser check on local dev (`VITE_USE_SUPABASE=true npx vite --port 5183 --strictPort`, login via env `PV_USER`/`PV_PASS`): the three forms show the new fields, the time rule message appears, layout OK at 1366 and 390 px — **no saving to the live database**. Delete screenshots, stop the server.
- [ ] **Step 6: Commit** `feat(calendar): booking forms capture email, edit date, require a time, show invite status`.

---

### Task 7: Settings card "Calendar invitations"

**Files:**
- Modify: `src/components/pages/SettingsPage.jsx`

**Interfaces:**
- Consumes: Task 5 `inviteSettings`, `setInviteSettings`, `saveInviteSettings`.
- Produces: a second card under Quote Follow-ups: on/off switch, test-mode switch + test email (valid email required when test mode is on — reuse `validateSettings`-style message `Test mode needs a valid test email address.`), status line ("Off — no invitations are sent" / "On — new bookings get a calendar invitation"), Save; hidden with "not set up" text when `inviteSettings` is null.

- [ ] **Step 1:** implement; `npm run build`.
- [ ] **Step 2:** browser check (no saving to live data), screenshots deleted.
- [ ] **Step 3: Commit** `feat(calendar): Settings card for calendar invitations`.

---

### Task 8: Rollout and acceptance (controller + user)

- [ ] Full test sweep: backend `node --test` (calendar + follow-up files), `node execution/test_invite_rules.mjs`, the other `execution/test_*.mjs`, `npm run build`.
- [ ] User: `gcloud auth login` (interactive). Deploy `whatsapp-service` (`--source . --clear-base-image`; no env change needed).
- [ ] `POST /run-calendar-sync?probe=true` with the secret → `{probe:'ok'}`. If it reports a permission error: the user re-authorises the Pearlview Gmail connection with the calendar permission (`execution/mint_gmail_calendar_token.cjs`, then `--update-env-vars GMAIL_SEND_REFRESH_TOKEN=…`) — must keep `gmail.send`; confirm `/send-invoice` still works with a test invoice afterwards.
- [ ] Create scheduler job `pearl-view-calendar-sync` (`*/5 * * * *`, Australia/Sydney, asia-southeast1, POST, header `x-cron-secret`); trigger once → 200 `skipped:'disabled'`.
- [ ] Local review → user says "push it" → `git push origin main`; confirm the live bundle.
- [ ] Acceptance in test mode (feature ON, test email = John's): book `TEST Calendar Jane` with an email + time → invite arrives at the test inbox within ~5 min; change its date in the Edit window → the same event moves; cancel it → cancellation arrives; a booking without a time is blocked in the form; a booking without an email shows "No email". Then delete TEST bookings, test mode OFF = live (new bookings only).
- [ ] PMS: one plain-language task "Clients automatically get a calendar invitation when their window clean is booked" → Done; memory updated.
