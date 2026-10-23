-- Automatic calendar invitations — booking columns, settings, sync-flag trigger.
-- Run ONCE in the Supabase SQL editor (NSW project zagmrxxmhyprhnhucqpo). Safe to re-run.
-- Ships OFF (enabled=false) and in test mode. Then verify:
--   node --env-file=.env execution/test_calendar_trigger.mjs
begin;
set local lock_timeout = '5s';  -- don't queue dashboard writes behind a long ALTER

-- 1. invite state on each booking
alter table bookings
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

  -- UPDATE: legacy rows are never flagged
  if old.gcal_status is not distinct from 'legacy' then
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

commit;
