# Leads ↔ Bookings ↔ Revenue Linkage Hardening

**Date:** 2026-07-23
**Status:** Design — awaiting user approval

## Goal

Eliminate the class of bugs where the same person's **lead**, **booking**, and **payment** disagree across the dashboard (calendar shows one amount/status, the Job Done column shows another). Make the three records reliably linked and consistently synced, and add a safety net that surfaces any future drift.

## Root cause (what today's cluster of bugs had in common)

`leads`, `bookings`, and `revenue` are three separate tables. They are associated at runtime by **fuzzy matching on phone, then Client Name** — not by a stable id. And the "keep them consistent" logic is **duplicated across ~6 handlers** in `src/hooks/useLeads.js` (`changeStatus`, `savePaidInfo`, `recordBookingPayment`, `removeCalBooking`) and `src/context/LeadsContext.jsx` (`confirmBook`). Whenever a case isn't covered by one of those copies, the records drift:

- **Tania** — two phone-less same-name leads shared one revenue row (name match).
- **Isaac** — demoted lead kept a stale scheduled date and lingered on the calendar.
- **Michelle** — booking Cancelled but lead stayed Booked; resurfaced via the lead path.
- **Bailey** — payment recorded on a phone-less lead didn't sync the booking amount (calendar $800 vs paid $300).

All four are the same weakness wearing different hats.

## Approach: app-layer reconcile + audit script (NOT database triggers)

A single reconcile function in the app, plus a standalone audit/repair script — **not** Postgres cross-table triggers. Triggers on live money data are hard to test, hard to debug, and risky to roll back; the app-layer + audit approach delivers the same robustness with far less blast radius and full testability.

## Design

### 1. Stable links (foundation)

- **Always persist `bookings.lead_id` and `revenue.lead_id` on create.**
  - `revenue.lead_id` — done for the payment path (`savePaidInfo`/`writeRevenue`, `recordBookingPayment`) as of 2026-07-23.
  - `bookings.lead_id` — **currently never persisted** (the column exists in `supabase_schema.sql`, but the app only sets an in-memory `linkedLeadId` that is null on reload). Fix: add `'Lead Id': 'lead_id'` to `BOOKING_COLS` in `src/utils/supabaseClient.js`, and set it wherever a booking is created from a lead: `confirmBook` (LeadsContext), `addCalBooking`, and `recordBookingPayment`'s create-lead branch. Backend `whatsapp-service/sb.js` `createBooking` gets the same mapping.
- **Matching order everywhere: `lead_id` → phone → name.** Name/phone remain only as a legacy fallback for pre-link rows. A record that carries a `lead_id` never matches by phone/name.

### 2. One-time backfill script

`execution/backfill_lead_links.cjs` (Node, `service_role`, `--dry-run` default):
- For every `booking`/`revenue` row with null `lead_id`, find the matching lead by phone, then name.
- **Ambiguous matches (more than one candidate lead) are reported and skipped, never auto-linked** — the operator reviews those manually.
- `--dry-run` prints the full plan (would-link, ambiguous, no-match) and writes nothing. `--apply` performs the writes after review.

### 3. Central reconcile (the real fix)

Split into a **pure decision function** (testable) and a **thin applier** (does I/O):

- `src/utils/reconcile.js` → `computeReconcile({ lead, booking, revenue }) → { bookingPatch|null, revenuePatch|null }`. Pure, no I/O, fully unit-testable. Encodes the source-of-truth rules below. Idempotent (running it on already-consistent inputs yields empty patches).
- `useLeads.reconcileLead(leadId)` — resolves the lead's linked booking + revenue from state (by `lead_id`→phone→name), calls `computeReconcile`, applies the returned patches via `updateRecord`/`patchAirtable` + local state. **Replaces** the ad-hoc sync blocks currently inside `changeStatus`, `savePaidInfo`, `recordBookingPayment`, and `removeCalBooking`; each of those now calls `reconcileLead` after its own primary write.

`reconcileLead` **syncs** existing linked records; it does **not** create bookings from scratch — booking creation stays in `confirmBook`/`addCalBooking` (which then call `reconcileLead`).

#### Source-of-truth rules (confirmed with user)

- **Booking status follows lead status:**
  - `booked` → booking active (`Scheduled`).
  - `job_done` → booking `Completed`.
  - `new` / `in_progress` / `quote_sent` / `refused` / `archived` / `scam` → linked active booking → `Cancelled`.
- **Amount source of truth = the payment (`revenue`).** When a revenue row exists for the lead, the booking's `amount` mirrors the revenue amount. When there is no payment yet, the booking keeps its own amount (the quote/estimate).
- Reconcile only ever touches a lead's **own** linked records (matched `lead_id`-first) and never a different same-named lead's booking/revenue.

### 4. Consistency-audit script (safety net)

`execution/audit_consistency.cjs` (Node, `service_role`), `--report` (default) / `--repair`:
- Detects: booking amount ≠ linked revenue amount; lead `Booked` but booking `Cancelled`/missing; lead `Job Done` with no revenue or non-`Completed` booking; orphaned bookings/revenue (no lead link and no phone/name match); same-name collisions (multiple leads sharing one revenue/booking).
- `--report` prints a categorized drift report and writes nothing. `--repair` applies the same `computeReconcile` logic to fix drift (reusing the pure function so report and repair can't diverge). Run on demand now; can be scheduled later.

### 5. DB guards (light only)

- Keep the existing `bookings.lead_id` / `revenue.lead_id` foreign keys (`on delete set null`).
- Safe partial-unique indexes only where a natural key exists (e.g. the `fb_lead_id` index already added). **No heavy cross-table triggers.**

## Rollout — four independently-shippable phases

1. **Linking writes + `lead_id`-first matching** — backward-compatible; new rows get `lead_id`, matching prefers it. Ship + verify.
2. **Backfill** — `--dry-run` → operator reviews (esp. ambiguous) → `--apply`.
3. **Central `reconcileLead()`** — extract `computeReconcile`, unit-test it, then replace the ad-hoc sync in the handlers. Heaviest phase; most testing.
4. **Audit script** — `--report` first (surface any remaining drift), `--repair` after the report is eyeballed.

Each phase is a separate PR/deploy so risk stays contained.

## Testing

- **`computeReconcile` unit tests** (`execution/test_reconcile.cjs`, standalone assert-based like the existing `test_fb_extractor.cjs`) covering every edge case that bit us: phone-less lead, two same-name leads, booking Cancelled while lead Booked, lead demoted out of Booked, `job_done` with/without payment, amount conflict (revenue wins), and the idempotent no-op case.
- **Backfill/audit** run in `--dry-run`/`--report` mode against live data first; nothing writes until the report is reviewed.
- **Manual re-verification** of the four real scenarios (Bailey, Michelle, Isaac, Tania) end-to-end in the dashboard after Phase 3.

## Edge cases

- Ambiguous same-name, no phone → backfill/audit **flag, never auto-link**; reconcile only acts on already-linked or unambiguous records.
- A lead with no booking → reconcile is a no-op on the booking side (nothing to sync); booking creation is confirmBook's job.
- `job_done` + paid → booking `Completed`, amount = revenue. `job_done` + unpaid → booking `Completed`, amount unchanged (no revenue to mirror).
- Backend-created leads/bookings (whatsapp-service) set `lead_id` where the lead is known; where a booking is created before its lead exists, the backfill/audit links it later.

## Out of scope (YAGNI)

- Postgres triggers / DB-enforced cross-table sync.
- Rewriting the Airtable fallback path (it's a rollback safety net; the reconcile targets the live Supabase path, with the Airtable path left working as-is).
- A general refactor of `useLeads.js` beyond extracting the reconcile logic.
- Merging/deduping existing duplicate leads (separate concern; the audit only *reports* same-name collisions).

## Files affected

- **Modify:** `src/utils/supabaseClient.js` (`BOOKING_COLS` += `lead_id`), `src/context/LeadsContext.jsx` (`confirmBook` sets booking `lead_id` + calls reconcile), `src/hooks/useLeads.js` (set booking `lead_id` on create; replace ad-hoc sync with `reconcileLead`), `whatsapp-service/sb.js` (`createBooking` maps `lead_id`).
- **Create:** `src/utils/reconcile.js` (pure `computeReconcile`), `execution/backfill_lead_links.cjs`, `execution/audit_consistency.cjs`, `execution/test_reconcile.cjs`.
