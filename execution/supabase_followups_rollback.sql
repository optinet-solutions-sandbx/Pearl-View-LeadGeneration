-- Quote follow-ups: emergency rollback. Run in the Supabase SQL Editor to disable the feature.
-- Stops new enrolments and switches the job off; data and columns are kept.
begin;
drop trigger if exists leads_followup_enroll on leads;   -- drop the trigger FIRST: it reads followup_settings
drop function if exists leads_followup_enroll();
update followup_settings set enabled = false where id = 1;
commit;
-- Columns/tables are left in place (leads_enriched selects l.*; dropping leads columns requires rebuilding the view).
