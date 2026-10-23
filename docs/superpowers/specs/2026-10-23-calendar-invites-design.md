# Automatic Calendar Invitations for Booked Jobs — Design

**Date:** 2026-10-23
**Status:** Design — awaiting approval
**Requested by:** Asaf (owner), via John

## Intent — why

Asaf wants a booked window-cleaning job to land in the **client's own calendar** automatically, "like when you book a flight and it pops into your phone calendar". Today only clients who rebook themselves through the "Book your next visit" link in the invoice email get a calendar invitation; the office books most jobs from the dashboard and those clients get nothing. Success = a client the office books receives an invitation from Pearlview without anyone doing anything extra, it stays correct if the job moves, and disappears if the job is cancelled.

## Goals

1. When the office **books a job in the dashboard** for a client who has an email address, the client automatically receives a calendar invitation from Pearlview (Google Calendar invitation sent from the Pearlview Gmail account's calendar — auto-appears for Gmail/Google Calendar users; Outlook/Apple users get an invitation to accept).
2. **Rescheduling** moves the *same* event in the client's calendar (no duplicate). This requires a new ability: **editing a booking's date** in the dashboard (decided by John — today a booking's date cannot be changed, only cancelled and re-booked).
3. **Cancelling** a booking removes it from the client's calendar (client receives Google's cancellation).
4. **Future visits**: every future booking gets its own invitation when it is booked.
5. The client **self-rebook** path (invoice link → `/book` page), which already sends an invitation, joins the same system so its events can also be moved/cancelled later.

## Non-goals

- Recurring series / "every fortnight" bookings — the CRM has no repeating bookings; each visit is booked on its own (my call).
- Pearlview-sent reminder messages (email/SMS the day before). **My call:** rely on the client's own calendar reminders, matching the original request ("allow calendar reminders to notify clients"). Organiser-set reminders usually do not reach attendees in Google/Outlook, so we don't promise a specific reminder time. Can be added later as a separate feature.
- Invitations for jobs marked Completed, or for technicians/workers.
- Backfilling invitations for every existing future booking automatically (see Questions).

## Anti-goals (would make this a failure even if it "works")

- A client receives an invitation with a **wrong time** (e.g. 9am guessed when nothing was entered) — hence "require a time".
- Duplicate events in the client's calendar for one job.
- An invitation sent to the wrong person, or to a real client during testing.
- Booking in the dashboard becomes slower or fails because the calendar service is down.

## Decisions (John's)

| Topic | Decision |
|---|---|
| Job booked without a time | **Require a time** on the booking form whenever the client has an email address. |
| Job moves to another day | **Add date editing** to the booking edit window; the client's existing event moves. |
| Scope | Build what Asaf asked; plan first, decide together. |

## Current state (from code investigation, 2026-10-23)

- Booking creation in the dashboard: `BookModal → confirmBook` (lead in scope, `lead.email` available but not passed) and Calendar **New Appointment** (no email field, no lead link) — both go through `useLeads.addCalBooking`.
- Booking rows have **no email column** and **no external event id**; `lead_id` links to the lead when known (fuzzy phone/name fallbacks exist).
- Job time is optional, free text, 12-hour ("9:00 AM") from the dashboard, 24-hour ("09:00") from the rebook page.
- Booking date is not editable (`updateCalBooking` has no `Date` mapping; the edit modal has no date field).
- Cancel = booking status `Cancelled` (soft delete) via `removeCalBooking`, or a lead leaving Booked.
- The Cloud Run service already creates real Google Calendar events for self-rebooks (`booking.js createCalendarInvite`: primary calendar of the Pearlview Gmail account, client as attendee, `sendUpdates:'all'`, 1-hour event), falling back to an emailed `.ics`; it does not store the event id and has no update/delete code. It uses `REBOOK_TZ` (default `Australia/Brisbane`), which differs from NSW daylight-saving time.
- Dashboard → Cloud Run calls today have no authentication.

## How it works (my calls unless stated)

**Approach — a background sync job, not a direct call from the dashboard.** (My call.) The dashboard keeps writing bookings exactly as now. A database trigger marks a booking "needs calendar sync" whenever its date, time, status, service, address or client link changes. A scheduled job on the existing Cloud Run service (every 5 minutes, same pattern as the quote follow-ups) picks up those bookings and creates, moves or cancels the matching Google Calendar event, then stores the event id on the booking. Why: every booking path is covered automatically (dashboard, calendar, self-rebook, future paths), booking never waits on Google, failures retry, and no new unauthenticated endpoint is exposed. Cost: an invitation can take up to ~5 minutes to arrive.

**Who gets an invitation:** a booking that is Scheduled, dated today or later, has a job time, and whose client has an email address (from the linked lead; otherwise the client record matched by phone). Bookings without an email are simply skipped and marked "No email" so the office can see why.

**Event content:** title "Window Cleaning — Pearlview" (service + business name), the booked date and time (business time zone, NSW = Australia/Sydney), 2-hour block (my call — length isn't recorded per job), location = service address (or city), description with the service, Pearlview's phone/email, and "reply to this email if you need to change your appointment". Sent from the Pearlview Gmail account's calendar.

**Reschedule:** the booking edit window gains a **Date** field (and keeps Time). Changing date or time updates the same Google event; the client gets Google's "updated invitation". The lead's scheduled cleaning date is kept in step.

**Cancel:** booking status → Cancelled (any path) deletes the event; the client gets Google's cancellation notice. Completed → no change to the event.

**Require a time:** the Book form and New Appointment form require a time when the client has an email (New Appointment gets an optional Email field, pre-filled from the matching client/lead).

**Visibility for the office:** each booking shows a small status: "📅 Invite sent", "No email", "Needs a time", or "Invite failed — will retry".

**Safety rollout (my call, same as follow-ups):** a "Calendar invitations" card in Settings with an on/off switch (ships OFF) and a test mode that sends every invitation only to a test address instead of the client. Turning it on does not touch bookings created before the switch (see Questions).

**Prerequisites:** the Pearlview Gmail account's Google connection must include calendar permission (a one-time re-authorisation if it doesn't), and the Google Calendar API must be enabled on the project — verified as the first build step. Time zone uses the business setting, fixing the Brisbane/Sydney mismatch for self-rebook invites too.

## Left to the builder

Exact trigger/column names and migration, sync batch size and retry/back-off, how the job claims rows (follow-ups' lease pattern is a good model), 12h→24h time parsing, how New Appointment looks up the client email, UI placement of the invite status, test-mode details, and tests (pure decision logic unit-tested like the follow-up core).

## Settled after the builder check (my calls)

- **Client email lives on the booking.** Bookings gain a client-email field, filled at booking time from the linked lead (or the client record matched by phone, or the New Appointment form's Email field). The booking edit window shows it and lets the office add or correct it. Adding an email to a "No email" booking queues it for sync. Correcting an email after an invitation went out swaps the attendee on the same event (old address gets Google's cancellation, new address gets the invitation). The trigger watches this field too. Emails edited later on the lead itself do not flow into existing bookings.
- **Self-rebook keeps its instant invitation** (the client is waiting on the confirmation page), but now stores the event id on the booking, so the sync job treats it as already sent — later moves/cancels work and no duplicate is created. If Google is unavailable and the emailed `.ics` fallback is used, the booking is marked "Invite emailed (can't be moved automatically)".
- **Time zone** = the business time-zone setting the service already has per branch (NSW → Australia/Sydney, Perth → Australia/Perth). Times typed by the office are local business time. The self-rebook path switches to the same setting (fixes today's Brisbane default, which is an hour off during NSW daylight saving).
- **Calendar permission** is verified first. If the Pearlview Gmail connection lacks calendar access, John does a one-time browser re-authorisation (same idea as the Cloud Run login); building and testing continue in test mode meanwhile.

## Decided by John after the builder check

- **Existing bookings at switch-on: only new bookings.** Invitations go out only for jobs booked (or changed) *after* the switch is turned on. Every booking that exists when the feature is installed is marked "existing — never sync" in the migration, so editing it later never sends a surprise first invitation. This also covers older self-rebook bookings whose event id was never stored (no duplicates).
