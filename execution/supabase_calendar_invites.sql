-- Automatic calendar invitations — booking columns, settings, sync-flag trigger.
-- Run ONCE in the Supabase SQL editor (NSW project zagmrxxmhyprhnhucqpo). Safe to re-run.
-- Ships OFF (enabled=false) and in test mode. Then verify:
--   node --env-file=.env execution/test_calendar_trigger.mjs
-- Run the verifier BEFORE the pearl-view-calendar-sync scheduler job exists (the job would race the TEST rows).
-- The Perth branch needs this SQL before its Cloud Run deploy.
-- Emergency disable: execution/supabase_calendar_invites_rollback.sql
begin;
set local lock_timeout = '5s';  -- don't queue dashboard writes behind a long ALTER

-- 1. invite state on each booking
alter table bookings
  add column if not exists service_address   text,  -- also added by supabase_technician_rls.sql; keeps this file self-contained
  add column if not exists client_email      text,
  add column if not exists gcal_event_id     text,
  add column if not exists gcal_status       text,
  add column if not exists gcal_attendee     text,
  add column if not exists gcal_sync_needed  boolean not null default false,
  add column if not exists gcal_rev          int not null default 0,
  add column if not exists gcal_fail_count   int not null default 0,
  add column if not exists gcal_next_at      timestamptz,
  add column if not exists gcal_synced_at    timestamptz;
create index if not exists bookings_gcal_due_idx on bookings (gcal_sync_needed, gcal_next_at);

-- 2. first install ONLY: every booking that exists today is 'legacy' (never invited).
--    Guarded on the settings table not existing yet, so a re-run can never mark
--    newer bookings legacy. Runs before the trigger exists (created in step 4).
do $legacy$
begin
  if to_regclass('public.calendar_invite_settings') is null then
    update bookings set gcal_status = 'legacy' where gcal_status is null;
  end if;
end
$legacy$;

-- 3. owner settings — a single row (id = 1)
create table if not exists calendar_invite_settings (
  id          int primary key default 1 check (id = 1),
  enabled     boolean not null default false,
  test_mode   boolean not null default true,
  test_email  text,
  updated_at  timestamptz not null default now()
);
insert into calendar_invite_settings (id) values (1) on conflict (id) do nothing;

alter table calendar_invite_settings enable row level security;
drop policy if exists owner_all on calendar_invite_settings;
create policy owner_all on calendar_invite_settings for all using (is_owner()) with check (is_owner());
grant select, insert, update, delete on calendar_invite_settings to authenticated;

-- 4. sync-flag trigger — fires for EVERY write path (dashboard, backend)
create or replace function bookings_gcal_mark() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare
  v_enabled boolean;
begin
  -- missing row / missing table / any error => disabled; this trigger never blocks a write
  begin
    select enabled into v_enabled from calendar_invite_settings where id = 1;
  exception when others then
    v_enabled := false;
  end;
  v_enabled := coalesce(v_enabled, false);

  if tg_op = 'INSERT' then
    -- a supplied status (self-rebook inserts 'sending') is left alone
    if new.gcal_status is null and v_enabled then
      new.gcal_status      := 'pending';
      new.gcal_sync_needed := true;
      new.gcal_rev         := 1;
    end if;
    return new;
  end if;

  -- UPDATE: legacy rows are never flagged; neither are 'emailed_ics' rows (the client
  -- already holds an .ics entry from the self-rebook email — syncing would add a 2nd event)
  if old.gcal_status in ('legacy', 'emailed_ics') then
    return new;
  end if;

  -- only a change to an invite-relevant column re-flags; gcal_*-only writes
  -- (the sync job's own bookkeeping) never do and never bump gcal_rev
  if (new.date, new.job_time, new.booking_status, new.job_service,
      new.service_address, new.city, new.client_email, new.client_name)
     is distinct from
     (old.date, old.job_time, old.booking_status, old.job_service,
      old.service_address, old.city, old.client_email, old.client_name)
     and (v_enabled or new.gcal_event_id is not null) then
    new.gcal_sync_needed := true;
    new.gcal_rev         := old.gcal_rev + 1;
    new.gcal_fail_count  := 0;
    new.gcal_next_at     := null;
  end if;
  return new;
end
$fn$;

drop trigger if exists bookings_gcal_mark on bookings;
create trigger bookings_gcal_mark before insert or update on bookings
  for each row execute function bookings_gcal_mark();

-- 5. technician column guard — the existing guard is a deny-list, so the new invite
--    columns must be added to its protected tuple (otherwise a technician could set
--    client_email to redirect an invitation, or gcal_status='legacy' to silence it).
--    Body copied verbatim from supabase_technician_rls.sql, plus client_email,
--    gcal_event_id, gcal_status, gcal_attendee, gcal_synced_at.
--    DELIBERATELY NOT protected: gcal_sync_needed, gcal_rev, gcal_fail_count, gcal_next_at —
--    bookings_gcal_mark (fires first: 'g' < 't') sets exactly those when a technician
--    marks a job done (booking_status change), and the guard must not reject that.
--    A technician Mark Done changes only booking_status/tech_notes/tech_completed_at, none
--    of which is in the tuple, and the gcal trigger never touches the protected gcal_* columns on UPDATE.
create or replace function bookings_tech_guard() returns trigger
  language plpgsql security definer as $$
begin
  if auth.uid() is not null and not is_owner() then
    if (new.booking_name, new.client_name, new.phone, new.city, new.job_service,
        new.date, new.amount, new.job_time, new.assigned_worker, new.upsell_amount,
        new.upsell_notes, new.lead_id, new.assigned_worker_id, new.service_address,
        new.client_email, new.gcal_event_id, new.gcal_status, new.gcal_attendee, new.gcal_synced_at)
       is distinct from
       (old.booking_name, old.client_name, old.phone, old.city, old.job_service,
        old.date, old.amount, old.job_time, old.assigned_worker, old.upsell_amount,
        old.upsell_notes, old.lead_id, old.assigned_worker_id, old.service_address,
        old.client_email, old.gcal_event_id, old.gcal_status, old.gcal_attendee, old.gcal_synced_at) then
      raise exception 'technicians may only update booking_status, tech_notes and completion time';
    end if;
  end if;
  return new;
end $$;

commit;
