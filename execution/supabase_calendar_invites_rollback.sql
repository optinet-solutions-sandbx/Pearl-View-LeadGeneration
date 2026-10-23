-- Calendar invitations — EMERGENCY DISABLE. Run in the Supabase SQL editor.
-- Stops all flagging immediately and turns the feature off. Safe to re-run.
begin;
set local lock_timeout = '5s';

drop trigger if exists bookings_gcal_mark on bookings;   -- FIRST: nothing flags after this
drop function if exists bookings_gcal_mark();
update calendar_invite_settings set enabled = false where id = 1;

commit;

-- Left in place on purpose: the bookings gcal_* / client_email columns and the
-- calendar_invite_settings table (data is kept; dropping is a separate, deliberate step).
-- NOTE: if the settings table is dropped, re-running supabase_calendar_invites.sql treats it
--   as a first install and marks every booking with a null gcal_status 'legacy' again.
-- The technician-guard change (protected invite columns) is intentionally NOT rolled back:
--   it only adds protection.
