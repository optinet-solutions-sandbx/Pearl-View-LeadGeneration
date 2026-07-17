# Facebook/Instagram Lead-Ads → Dashboard Ingestion + Email Alerts

**Date:** 2026-07-17
**Status:** Design — awaiting user approval

## Goal

Automatically pull Meta (Facebook + Instagram) Lead-Ads leads out of the Google Sheet that Meta auto-populates, land them in the dashboard as leads (Supabase), and email an alert to **service@pearlview.com.au** for each genuinely new lead.

This is an **extension of the existing `email-extractor.js` + `/extract-emails` cron**, not new infrastructure.

## Data source

- **Sheet:** `1h-3Y_OMHshJyydlP6yt-Qc94UgsXEUAM8k6Z0K42e78`, tab `gid=0`.
- **Access:** link-shared "anyone with the link can view" on a *different* Google account. We read it as CSV over plain HTTP — **no OAuth/token needed for reading**:
  `https://docs.google.com/spreadsheets/d/<ID>/export?format=csv&gid=0`
- **Format:** Meta's native Lead-Ads → Sheets export, 17 columns.

### Columns & quirks

| Sheet column | Use | Quirk |
|---|---|---|
| `id` | Dedup key (`fb_lead_id`) | Prefixed `l:` — stable & unique per lead submission |
| `full_name` | Client Name | — |
| `phone_number` | Phone Number | **Prefixed `p:`** — must strip → `+61402012700` |
| `email` | Email | — |
| `platform` | Source: `fb`→Facebook, `ig`→Instagram | — |
| `campaign_name`, `form_name` | Subject + Notes context | may contain non-ASCII (Hebrew) |
| `created_time` | Inquiry Date | ISO w/ TZ offset → reuse `formatInquiryDate` (→ Australia/Sydney) |
| `ad_name`, `adset_name`, `is_organic`, `inbox_url`, `lead_status` | Notes context only | — |

- **Test rows:** Meta injects a test lead with placeholder values (`<test lead: dummy data for …>`, email `test@meta.com`). These MUST be skipped.
- **CSV values can contain commas/quotes** → use a small RFC-4180-aware parser (no naive `split(',')`), written inline (no new npm dependency).

## Decisions (confirmed with user)

1. **Email-alert scope:** Facebook/Instagram leads **only**. Form + call leads keep their existing WhatsApp alerts, unchanged.
2. **Channel for FB/IG leads:** **Email only** — no WhatsApp for this source.
3. **Source labeling:** **Split** — `fb`→`Facebook`, `ig`→`Instagram`. Adds `Instagram` to the dashboard's `LEAD_SOURCES`.

## Architecture

Three surfaces change:

### 1. Backend — `whatsapp-service/email-extractor.js`

New `extractFacebookLeads({ notify })`, folded into `runExtraction()` so it rides the **existing `/extract-emails` cron** (no new scheduler).

Flow:
1. `GET` the CSV export URL (axios). If the response isn't CSV (sharing revoked → Google returns an HTML login page), log a loud `[ALERT] 🚨` and return `{ processed: 0, error }` — never throw (don't break form/call extraction).
2. Parse CSV (inline parser) → array of row objects keyed by header.
3. **Filter out**: test rows (placeholder/`test@meta.com`), rows with no `id`, rows with neither phone nor email.
4. **Idempotency:** one `GET /rest/v1/leads?select=fb_lead_id&fb_lead_id=not.is.null` up front → `Set` of already-imported ids. Skip any row whose `id` is in the set.
5. For each new row, `sb.createLead({...})` with the mapping below (writes `fb_lead_id`).
6. If `notify` → send the email alert (below). No WhatsApp call.
7. Return `{ processed, total, skipped }`.

### 2. Database — Supabase `leads`

Add one nullable trace column (mirrors `airtable_id`):
```sql
alter table leads add column if not exists fb_lead_id text;
create unique index if not exists leads_fb_lead_id_key
  on leads (fb_lead_id) where fb_lead_id is not null;
```
- `leads_enriched` is `select l.*` → the column flows through automatically; **no view change**.
- The partial unique index is defense-in-depth against a double-run/race creating duplicates.
- `sb.js` `LEAD_COLS` gets `'FB Lead Id': 'fb_lead_id'` so `createLead` can write it via the existing translation layer.

### 3. Frontend — `src/utils/constants.js`

Add `'Instagram'` to `LEAD_SOURCES` so it's a first-class filter/dropdown value (also makes it selectable in `NewLeadModal`). Instagram uses default source styling unless a color is later added — out of scope here.

## Field mapping (sheet row → lead)

| Lead field | Value |
|---|---|
| `Client Name` | `full_name` (fallback `—`) |
| `Phone Number` | `phone_number` with `p:` stripped |
| `Email` | `email` |
| `Lead Source` | `Facebook` if `platform=fb`, `Instagram` if `platform=ig`, else `Facebook` |
| `Inquiry Subject/Reason` | `Facebook Lead Ad — {form_name}` / `Instagram Lead Ad — {form_name}` |
| `Inquiry Date` | `formatInquiryDate(created_time)` |
| `Notes` | `📘 {Platform} lead — campaign "{campaign_name}", form "{form_name}". Meta lead {id}.` |
| `Lead Status` | `New Lead` |
| `fb_lead_id` | raw `id` (e.g. `l:2046983545902460`) |

## Email notification

- Reuses the **existing Gmail-API send path** from `invoice.js` (`gmail.users.messages.send({ raw })`) with the same token invoice uses: `GMAIL_SEND_REFRESH_TOKEN || GMAIL_FORM_REFRESH_TOKEN`. Factored into a tiny shared `sendPlainEmail({ to, subject, text, html })` helper (or inlined) — **no new auth, no new scope**.
- **To:** `FB_LEADS_NOTIFY_EMAIL` (default `service@pearlview.com.au`).
- **One email per new lead** (matches volume; low daily count). Subject: `New {Facebook|Instagram} lead: {name}`. Body: name, phone, email, platform, campaign/form, received time, and a link to the dashboard.
- Failure to email is logged but does **not** fail the import (lead is already saved).

## Scheduling & first run

- Rides the existing Cloud Scheduler → `POST /extract-emails`. No change to the schedule.
- **First run = silent backfill:** hit `POST /extract-emails?notify=false` once so all existing sheet rows import **without** emailing old leads. Cron thereafter (`notify=true`) emails only genuinely new rows.

## Env vars (Cloud Run — `whatsapp-service`)

| Var | Purpose | Default |
|---|---|---|
| `FB_LEADS_SHEET_CSV_URL` | Full CSV export URL (or build from a `FB_LEADS_SHEET_ID`) | — (required to enable) |
| `FB_LEADS_NOTIFY_EMAIL` | Alert recipient | `service@pearlview.com.au` |
| `GMAIL_SEND_REFRESH_TOKEN`, `GMAIL_OAUTH_CLIENT_ID/SECRET` | Email send | already set |

If `FB_LEADS_SHEET_CSV_URL` is unset, `extractFacebookLeads` no-ops (like the missing-refresh-token guards) so the feature is dark until configured.

## Edge cases

- Sharing revoked / non-CSV response → `[ALERT]`, skip, don't throw.
- Duplicate row / re-run → skipped via `fb_lead_id` set (+ DB unique index).
- Missing phone but has email (or vice-versa) → still imported (email or phone alone is enough).
- Empty/blank rows → skipped.
- Non-ASCII campaign names → preserved as-is in Notes.
- Same person submitting twice → two leads (each has a distinct Meta `id`), consistent with the existing "each submission is its own entry" policy for forms/calls.

## Testing

1. **CSV parse unit check** — feed the real fetched sample (incl. the Hebrew names + `p:` prefixes + the test row) → assert test row filtered, `p:` stripped, platform mapped.
2. **Dry-run against Supabase** — run `extractFacebookLeads({notify:false})` locally against the real sheet; verify N leads created, `fb_lead_id` populated, re-run creates 0.
3. **Email path** — one `notify:true` run (or a targeted test) → confirm an email lands in service@pearlview.com.au with correct fields.
4. **Idempotency** — run twice; second run reports `processed:0`.
5. **Frontend** — Instagram appears as a source filter; ig leads show under it.

## Out of scope (YAGNI)

- Writing back to the sheet / marking rows processed (we dedup on our side).
- OAuth/service-account access to the sheet (CSV export suffices while link-shared).
- Per-source badge colors/icons for Instagram.
- Digest emails / batching (one-per-lead is fine at current volume).
- Backfilling FB leads into the Airtable archive.

## Deployment

1. Run the `alter table` + index in the Supabase SQL editor.
2. Add `'Instagram'` to `constants.js`; deploy frontend (`git push` → Vercel).
3. Add env vars + deploy `whatsapp-service` to Cloud Run (`--update-env-vars`, `--clear-base-image`).
4. Silent backfill: `POST /extract-emails?notify=false`.
5. Verify, then let cron take over.
