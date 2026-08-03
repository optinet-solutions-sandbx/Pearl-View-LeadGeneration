# Directive: Replicate the System for a New Business Location

## Objective
Stand up the Pearl View lead-gen/CRM system for an **additional business location/owner** (first case: Asaf's **Perth** branch) as a **separate clone** — its own Supabase database, its own dashboard, its own Cloud Run service, its own emails/numbers, and its own invoice identity (ABN + bank) — while running the **same single codebase**. Locations differ only by environment variables. NSW stays untouched.

## When to use
Whenever a new owner/branch needs the same system with a different lead source (new emails + numbers) and its own finances. NOT for a new marketing brand under the *same* owner/DB — that's the existing LP1/LP2 (`website-*`) source-tag pattern in `email-extractor.js`.

## Architecture decision (locked 2026-07-31)
- **Separate clone**, one config-driven codebase (NOT a fork). Confirmed by John for Perth.
- Perth invoices under its **own ABN & bank** → own invoice identity + own invoice-number sequence.
- Same Supabase *account*, but a **separate Supabase project/database** per location.

## The config layer (already built)
- `whatsapp-service/config.js` — env-driven `BUSINESS` (name/address/phone/email/abn/bsb/account), `BRAND_NAME`, `BRAND_SHORT`, `DASHBOARD_URL`, `NOTIFY_FOOTER`, `TZ`. Every value defaults to NSW, so an unset var = NSW behavior.
- Backend reads config: `invoice.js`, `booking.js`, `booking-page.js`, `greenapi.js`, `whatsapp.js`, `email-extractor.js`, `index.js`, `ai.js`.
- Frontend: `src/utils/constants.js` → `BUSINESS_NAME`/`BUSINESS_INITIALS` (from `VITE_BUSINESS_NAME`); `supabaseClient.js` `AUTH_DOMAIN` (from `VITE_AUTH_DOMAIN`).
- Env templates: `whatsapp-service/.env.perth.example` (Cloud Run) and root `.env.perth.example` (Vercel).

## Inputs to collect from the owner (external — cannot be created by the agent)
1. Legal business name, **ABN**, bank **BSB + account**, business address (prints on invoices).
2. Two Gmail inboxes (website-form inbox + call-recording inbox).
3. Phone number(s) for call tracking + the owner's WhatsApp number.
4. Green-API instance (its own WhatsApp sender) OR a Meta WABA + approved templates.
5. Meta Lead-Ads Google Sheet CSV URL (if using FB/IG).
6. Landing page(s)/domain (so the form-email sender is known for `FORM_GMAIL_MATCH`).
7. Business timezone (Perth = `Australia/Perth`).

## Procedure
1. **Supabase:** create a new project (same account). In its SQL Editor run `execution/supabase_schema.sql` then `execution/supabase_enable_rls.sql`. Create the login user (mirror the NSW `pearlview` user setup). To change the invoice-number start, edit the floor in the `next_invoice_number()` function (default 209 → first invoice 210).
2. **Cloud Run:** copy `whatsapp-service/.env.perth.example`, fill real values, deploy:
   `gcloud run deploy <perth-svc> --source . --region <r> --project <gcp> --clear-base-image --update-env-vars "^@^KEY=val@..."`. Then mint Gmail tokens by visiting `<perth-cloud-run-url>/oauth/start?account=form` and `?account=call` (whitelist the redirect URI in the GCP OAuth client first).
3. **Vercel:** new project from this same repo; set the `VITE_*` vars from the root `.env.perth.example`; deploy. Put the resulting dashboard URL back into Cloud Run as `DASHBOARD_URL`, and the Cloud Run `/notify-lead` URL into Vercel as `VITE_WEBHOOK_URL`.
4. **Verify:** submit a test form + place a test call → lead appears in the Perth dashboard; owner gets a WhatsApp notification; send a test invoice → PDF shows the correct ABN/bank/brand and the right timezone date.

## Edge cases / follow-ups (need the location's real setup)
- **Form/call parsers** (`email-extractor.js` `parsePearlViewForm`/`parseCrystalProForm`/`parseCallReport`) assume NSW's Squarespace-form + call-tracking email formats. If the new location's providers differ, add a parser/routing branch and set `FORM_GMAIL_MATCH` to its senders. Get a sample form email + call-report email first.
- The website source tag (`website-pearlview`) is hardcoded in the parser — give the new location its own source tag.
- Frontend LP1/LP2 brand chips (Pearl View/Crystal Pro) are string-matched across ~10 components — cosmetic; adapt to the new location's source taxonomy if desired.
- Never reuse `BOOK_TOKEN_SECRET` across locations.
