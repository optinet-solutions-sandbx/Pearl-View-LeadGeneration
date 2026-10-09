# Quote Follow-ups — Automatic Email Sequence for Unanswered Quotes

**Date:** 2026-10-09
**Status:** Design — awaiting user approval

## Goal

When a lead sits in **Quote Sent** with no response, automatically email the customer a 3-step follow-up sequence (the owner's scripts), stop as soon as anything happens (status change, customer reply, manual stop), and after the final email move the lead to **Refused** so the board stays clean. The owner controls everything from a new **Settings** page: on/off, timing, wording, signature, send window. A **test mode** lets us run the whole sequence on dummy leads without any real customer receiving anything.

## Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Channel | **Email only**, via the existing Gmail API sender. Leads with no email are flagged "No email — call them", never sent. |
| Send mode | **Fully automatic** once enabled. Per-lead Stop/Start. |
| After FU3 | Lead auto-moves to **Refused**, reason code `no_response` (label "No Response to Follow-ups" — added to `REFUSE_LABELS` + refusal stats). |
| Stop rules | (1) status leaves Quote Sent, (2) customer replies by email, (3) manual Stop button. |
| Existing Quote Sent leads | **Not** auto-enrolled. Only leads entering Quote Sent while the feature is on. Older ones get a per-lead **Start** button. |
| Testing | **Test-mode redirect** (Settings switch) + manual dummy leads named `TEST …`. |
| Engine host | `whatsapp-service` (Cloud Run) endpoint, triggered by **Cloud Scheduler every 15 min** — same pattern as `/extract-emails`. Rejected: Supabase pg_cron + Edge Function (re-implement Gmail OAuth in Deno, second deploy target); Vercel Cron (hobby = daily only, spreads Gmail secrets). |

## Context (current state)

- **"Send Quote" (`QuoteSendModal` → `confirmQuoteSend`) only records `quote_amount` and sets status.** It emails nothing, and nothing records *when* the lead entered Quote Sent.
- Gmail sending exists in `whatsapp-service/invoice.js` (`buildOAuthClient`, `encodeHeader`, `b64url`, `sendInvoiceEmail`), From = `BUSINESS.email` (`service@pearlview.com.au`) via the `pearlviewwindowcleaning@gmail.com` OAuth account (`GMAIL_FORM_REFRESH_TOKEN`).
- `whatsapp-service/config.js` exports `BUSINESS` (name/email) and `TZ` (`Australia/Sydney`; Perth = `Australia/Perth`).
- `leads_enriched` view is `select l.*, …` → its column list is frozen at creation; new `leads` columns require **dropping and recreating** the view (columns get inserted before `paid_amount`, which `create or replace` rejects).
- RLS: `is_owner()` helper exists (technician-dashboard work). Technicians cannot read `leads`.
- **Duplicate-lead hazard:** `email-extractor.js` `FORM_GMAIL_MATCH` includes `from:pearlview.com.au` and has no `in:inbox`. A follow-up email (From `service@pearlview.com.au`) visible to the extractor's account could be ingested as a new lead — same class of bug as the FB/IG alert loop fixed 2026-07-17.
- No test framework in `whatsapp-service`; Node's built-in `node --test` is available.
- Two branches (NSW, Perth) share one codebase with separate Supabase DBs.

## Data model (`execution/supabase_followups.sql`, run in Supabase SQL Editor)

### New `leads` columns
| Column | Type | Meaning |
|---|---|---|
| `quote_sent_at` | timestamptz | Set every time the lead enters Quote Sent. |
| `followup_status` | text | `null` (never enrolled) · `active` · `stopped` · `replied` · `completed` · `no_email` · `error` |
| `followup_step` | int default 0 | Number of follow-up steps already processed (0–3). |
| `followup_next_at` | timestamptz | When the next step is due. Only meaningful while `active`. |
| `followup_stop_reason` | text | `status_changed` · `manual` · `replied` · `send_failed` |
| `followup_fail_count` | int default 0 | Consecutive send failures; 3 → `error`. |

Index: `(followup_status, followup_next_at)`.

### `followup_settings` (single row, `id = 1`)
| Column | Default |
|---|---|
| `enabled` boolean | `false` |
| `test_mode` boolean | `true` |
| `test_email` text | `null` |
| `sender_name` text | `Pearlview Window Cleaning` |
| `company_name` text | `Pearlview Window Cleaning` (fills `{company}`; stored here so the Settings preview matches the sent email exactly) |
| `window_start_hour` int | `8` (business TZ) |
| `window_end_hour` int | `18` |
| `steps` jsonb | 3 objects `{enabled, delay_hours, subject, body}` seeded with the default scripts below; delays **48 / 72 / 120 h** |
| `updated_at` timestamptz | `now()` |

### `followup_log`
`id uuid pk, lead_id uuid references leads(id) on delete cascade, step int, sent_at timestamptz default now(), to_email text, test_mode boolean, gmail_message_id text, error text`.

### RLS
`followup_settings` and `followup_log`: RLS on, `owner_all` policy using `is_owner()`. `service_role` bypasses (backend). Technicians see nothing.

### Enrollment trigger (`leads` BEFORE INSERT OR UPDATE, `SECURITY DEFINER`)
Runs regardless of which code path changes the lead (Kanban drag, detail panel, backend):
1. **Entering Quote Sent** (`INSERT` with status Quote Sent, or `UPDATE` where old status ≠ Quote Sent and new = Quote Sent):
   - `quote_sent_at = now()`
   - if `followup_settings.enabled`:
     - email present → `followup_status='active'`, `followup_step=0`, `followup_fail_count=0`, `followup_stop_reason=null`, `followup_next_at = now() + steps[0].delay_hours`
     - email blank → `followup_status='no_email'`
   - if not enabled → reset `followup_status=null`, `followup_step=0` (clears leftovers from an earlier Quote Sent cycle; the owner can still Start manually)
2. **Leaving Quote Sent** while `followup_status='active'` → `followup_status='stopped'`, `followup_stop_reason='status_changed'` — *unless the same statement already sets `followup_status`* (the engine's FU3 update sets `completed` + `Refused` together; the trigger must not overwrite it — check `NEW.followup_status IS DISTINCT FROM OLD.followup_status`).
3. **Email added later**: status Quote Sent, `followup_status='no_email'`, new email non-blank → `active`, **keeps its current step**, `next_at = now() + steps[0].delay_hours`.

The step-1 delay is read with a safe cast (bad value → 48 h) so a malformed setting can never block a lead save.

Then: drop + recreate `leads_enriched` (from its latest definition, incl. `security_invoker` and the `lead_id` fix in `supabase_fix_leads_enriched_lead_id.sql`) so it exposes the new columns.

## Engine (`whatsapp-service`)

### Files
- **`followup-core.js`** — pure functions, no I/O, unit-tested:
  - `renderTemplate(tpl, ctx)` — replaces `{first_name}`, `{client_name}`, `{company}`, `{sender}`, `{quote_amount}`. `first_name` = first word of `client_name`; falls back to `there` when blank or `Unknown Caller`. `quote_amount` formatted `$1,234`; blank if none. Unknown placeholders left as-is.
  - `inSendWindow(now, tz, startHour, endHour)`.
  - `nextEnabledStep(steps, fromStep)` — skips disabled steps.
  - `planAction(lead, settings, now)` → one of `hold` (test mode + non-TEST lead), `send {step, to, subject, body}`, `complete` (no enabled steps remain). Test mode: only leads whose `client_name` starts with `TEST` (case-insensitive) are processed; recipient = `test_email`; subject prefixed `[TEST → <real email>] `.
  - `afterSend(lead, settings, sentStep, now)` → field patch: increments step; if more enabled steps → `next_at = now + that step's delay_hours`; if this was the **last step and it is step 3** → `lead_status='Refused'`, `refusal_reason='no_response'`, `followup_status='completed'`; if last enabled step is not step 3 → `followup_status='completed'`, status unchanged.
- **`followup.js`** — orchestration: DB reads/writes (via `sb.js`, service_role), Gmail send, reply check, owner alert.
- **`index.js`** — `POST /run-followups` (requires header `x-cron-secret: $CRON_SECRET`, else 401). Optional `?dry=true` returns the planned actions without sending or writing — and ignores the on/off switch and send window, so the plan can be checked before switching on.

### Run loop (`runFollowups({dry})`)
1. Load settings. If `!enabled` or outside send window → return `{skipped: reason}`.
2. Select leads: `followup_status='active' and followup_next_at <= now() and lead_status='Quote Sent'`, plus `client_name ilike 'TEST%'` when test mode is on (so held real leads never crowd out test leads), order by `followup_next_at`, limit 25. The send window applies in test mode too.
3. Per lead:
   1. `planAction`. `hold` → skip (no write).
   2. **Claim** (lease): `update leads set followup_next_at = now() + interval '10 minutes' where id = $1 and followup_status = 'active' and followup_step = $n and followup_next_at <= now() returning id`. No row → another run has it; skip.
   3. **Reply check** (real leads and TEST leads alike): Gmail search in the sender account `from:<lead email> after:<quote_sent_at epoch>`, excluding our own sent mail. Hit → `followup_status='replied'`, `followup_stop_reason='replied'`, WhatsApp the owner via the existing Green-API path: `"<name> replied to your quote follow-up — check the inbox."` Stop.
   4. **Send** plain-text + simple HTML email with header `X-PearlView-Kind: followup`. Insert `followup_log` row.
   5. All engine writes after the claim go through `updateActiveFollowup`, which only applies while the lead is still `active` + Quote Sent — a status the owner sets mid-run (e.g. Booked) is never overwritten with Refused.
   6. Success → apply `afterSend` patch, reset `followup_fail_count`. Failure → log error, `followup_fail_count + 1`, `next_at = now() + 1h`; at 3 → `followup_status='error'`, `followup_stop_reason='send_failed'`.
4. Return `{processed, sent, held, replied, errors}`.

### Extractor guard (`email-extractor.js`)
Skip any message carrying `X-PearlView-Kind: followup` (code-level check alongside the existing FB/IG self-alert guard), and add `-in:sent` to the form query. Must be verified against a real follow-up email before go-live.

### Reply visibility (resolved 2026-10-10)
Follow-ups set `Reply-To: service@pearlview.com.au` (matches invoices). `service@` is the **form inbox** the extractor already reads (`GMAIL_FORM_REFRESH_TOKEN`), so the reply check searches it with that token. Sending uses the separate `GMAIL_SEND_REFRESH_TOKEN` account, so our own sent copies never sit in the searched inbox. The `TEST Reply` case proves it end-to-end.

## Default scripts (seeded into `steps`)

**Step 1 — 48 h after quote**
Subject: `Quick check-in regarding your window cleaning quote!`
```
Hi {first_name},

I hope you're having a great week! I just wanted to quickly follow up on the quote we sent over for your window cleaning.

Did you have any questions about the service details or pricing? We'd love to get your windows sparkling clean!

Best regards,
{sender}
```

**Step 2 — 72 h after step 1**
Subject: `Flexible scheduling available for your window cleaning`
```
Hi {first_name},

Following up on my previous message! I wanted to let you know we have a few open spots available on our schedule for this coming week.

If you have a specific day or time in mind that works best for you, let us know and we'll be happy to reserve it for you.

Best regards,
{sender}
```

**Step 3 — 120 h after step 2 (final; lead → Refused)**
Subject: `Final check-in from {company}`
```
Hi {first_name},

I haven't heard back from you, so I assume you may have put your window cleaning project on hold for now.

I'll go ahead and close out your inquiry in our system so we don't bother you with further messages. If you ever need us in the future, please feel free to reach out anytime!

Warm regards,
{sender}
```
`{company}` = `followup_settings.company_name` (fallback `BUSINESS.name`); `{sender}` = `followup_settings.sender_name`.

## Frontend

### Settings page (`src/components/pages/SettingsPage.jsx`, `case 'settings'` in `App.jsx`, Sidebar item, owner only — hidden when `readOnly`/technician)
One card, **Quote Follow-ups**:
- **Automatic follow-ups** master switch + status line (`N leads in a sequence · checks every 15 min`).
- **Test mode** switch + test email input (required to save with test mode on). Amber banner while on: "Test mode — only leads named TEST… are emailed, and only to <test email>. Real leads are held."
- **Signature** (`sender_name`), **send window** (start/end hour, business TZ).
- **3 step cards**: on/off, delay (number + days/hours unit, stored as hours), subject, body textarea, clickable placeholder chips that insert at cursor, live preview rendered with a sample lead (same `renderTemplate` logic, duplicated as a tiny frontend util).
- **Save** and **Reset to default scripts**.
- Reads/writes `followup_settings` directly via Supabase REST with the session JWT (new helpers in `supabaseClient.js`: `getFollowupSettings`, `saveFollowupSettings`, `getFollowupLog(leadId)`).
- If the table doesn't exist (e.g. a branch that hasn't run the SQL), the page shows "Follow-ups aren't set up for this branch yet" instead of erroring.

### Lead detail panel (`DetailPanel.jsx`, Quote Sent leads)
Follow-up block:
- Status line, e.g. `Follow-up 1 of 3 sent 9 Oct · next ~12 Oct 9:00am` / `Held — test mode` / `Customer replied — check inbox` / `No email — add one to enable follow-ups` / `Stopped` / `Send failed — check email address`.
- History from `followup_log` (step, date, to-address, `TEST` tag).
- Buttons: **Stop follow-ups** (active → `stopped`, reason `manual`); **Start / Resume follow-ups** (null / stopped / error / replied, email present → `active`, `followup_next_at = now()`, i.e. next step goes at the next check inside the send window; Start on a never-enrolled lead also sets step 0).
- Writes go through the existing `supabaseClient` translation layer (new field mappings for the follow-up columns) so `useLeads` state stays consistent.

### Lead card (`LeadCard.jsx`)
Small chip on Quote Sent cards: `FU 1/3`, `Replied`, `No email`, `Stopped`, `Held`. `Held` is derived client-side (test mode on + active + name not `TEST…`), so `followup_settings` is loaded once into `LeadsContext` (owner only) alongside leads.

## Testing

### Unit (TDD, `node --test whatsapp-service/followup-core.test.js`)
`renderTemplate` (all placeholders, blank/Unknown name fallback, missing quote), `inSendWindow` (boundaries, TZ incl. DST), `nextEnabledStep` (disabled steps skipped), `planAction` (test-mode hold vs send, TEST prefix match, recipient redirect + subject prefix), `afterSend` (step advance, FU3 → Refused, last-enabled-not-3 → completed only).

### Live verification before any real customer email
1. `POST /run-followups?dry=true` against the live DB — confirm the planned list matches expectations.
2. Send one TEST follow-up and confirm the extractor skips it (no new lead created) and the reply check doesn't match our own sent mail.

### Dummy-lead acceptance run (owner-facing)
1. Settings: follow-ups ON, test mode ON, test email = John's, all delays temporarily **1 hour**.
2. Create and move to Quote Sent:
   - `TEST Full Run` (any email) → FU1, FU2, FU3 arrive at the test inbox ~hourly → lead auto-moves to Refused.
   - `TEST Reply` (an address you control) → reply after FU1 → status Replied, sequence stops, owner WhatsApp alert.
   - `TEST Booked` → move to Booked after FU1 → Stopped.
   - `TEST Manual` → click Stop → Stopped.
   - `TEST No Email` → `No email` chip, nothing sent; add an email → becomes active.
3. Any real Quote Sent lead during the test shows `Held` and receives nothing.
4. Cleanup: delete TEST leads, restore delays 48/72/120 h, test mode OFF.

## Rollout

1. Run `execution/supabase_followups.sql` in the NSW Supabase SQL Editor (feature defaults to **off**).
2. User runs `gcloud auth login` interactively → deploy `whatsapp-service` with `--update-env-vars CRON_SECRET=…`.
3. Create Cloud Scheduler job `pearl-view-followups`: `*/15 * * * *`, TZ `Australia/Sydney`, `POST /run-followups`, header `x-cron-secret`.
4. Frontend: user reviews locally (`npm run dev`) → only on explicit approval, `git push origin main` (prod auto-deploys).
5. Dummy-lead acceptance run (above) with test mode on → owner switches test mode off.
6. Log to PMS.

**Perth:** code is shared and the feature is off by default; Perth's dashboard degrades gracefully until its own SQL + scheduler job are set up. Enabling Perth is a separate follow-up.

## Out of scope

SMS/WhatsApp follow-ups to customers; more than 3 steps; per-lead custom wording; email open/click tracking; threading follow-ups into one Gmail conversation; auto-enrolling pre-existing Quote Sent leads.
