-- Quote follow-ups — spec: docs/superpowers/specs/2026-10-09-quote-followups-design.md
-- Run ONCE in the Supabase SQL editor (NSW project zagmrxxmhyprhnhucqpo). Safe to re-run.
-- Ships OFF (enabled=false) and in test mode. Then verify:
--   node --env-file=.env execution/test_followup_trigger.mjs
begin;

-- 1. follow-up state on each lead
alter table leads
  add column if not exists quote_sent_at        timestamptz,
  add column if not exists followup_status      text,
  add column if not exists followup_step        int not null default 0,
  add column if not exists followup_next_at     timestamptz,
  add column if not exists followup_stop_reason text,
  add column if not exists followup_fail_count  int not null default 0;
create index if not exists leads_followup_due_idx on leads (followup_status, followup_next_at);

-- 2. owner settings — a single row (id = 1)
create table if not exists followup_settings (
  id                int primary key default 1 check (id = 1),
  enabled           boolean not null default false,
  test_mode         boolean not null default true,
  test_email        text,
  sender_name       text not null default 'Pearlview Window Cleaning',
  company_name      text not null default 'Pearlview Window Cleaning',
  window_start_hour int not null default 8  check (window_start_hour between 0 and 23),
  window_end_hour   int not null default 18 check (window_end_hour between 1 and 24),
  steps             jsonb not null,
  updated_at        timestamptz not null default now()
);

insert into followup_settings (id, steps) values (1, $steps$[
  {"enabled": true, "delay_hours": 48,
   "subject": "Quick check-in regarding your window cleaning quote!",
   "body": "Hi {first_name},\n\nI hope you're having a great week! I just wanted to quickly follow up on the quote we sent over for your window cleaning.\n\nDid you have any questions about the service details or pricing? We'd love to get your windows sparkling clean!\n\nBest regards,\n{sender}"},
  {"enabled": true, "delay_hours": 72,
   "subject": "Flexible scheduling available for your window cleaning",
   "body": "Hi {first_name},\n\nFollowing up on my previous message! I wanted to let you know we have a few open spots available on our schedule for this coming week.\n\nIf you have a specific day or time in mind that works best for you, let us know and we'll be happy to reserve it for you.\n\nBest regards,\n{sender}"},
  {"enabled": true, "delay_hours": 120,
   "subject": "Final check-in from {company}",
   "body": "Hi {first_name},\n\nI haven't heard back from you, so I assume you may have put your window cleaning project on hold for now.\n\nI'll go ahead and close out your inquiry in our system so we don't bother you with further messages. If you ever need us in the future, please feel free to reach out anytime!\n\nWarm regards,\n{sender}"}
]$steps$::jsonb)
on conflict (id) do nothing;

-- 3. send history
create table if not exists followup_log (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  step             int not null,
  sent_at          timestamptz not null default now(),
  to_email         text,
  test_mode        boolean not null default false,
  gmail_message_id text,
  error            text
);
create index if not exists followup_log_lead_idx on followup_log (lead_id, sent_at desc);

-- 4. owner-only access (the backend uses service_role, which bypasses RLS)
alter table followup_settings enable row level security;
alter table followup_log      enable row level security;
drop policy if exists owner_all on followup_settings;
create policy owner_all on followup_settings for all using (is_owner()) with check (is_owner());
drop policy if exists owner_all on followup_log;
create policy owner_all on followup_log for all using (is_owner()) with check (is_owner());
grant select, insert, update, delete on followup_settings, followup_log to authenticated;

-- 5. enrollment trigger — fires for EVERY write path (Kanban, panel, backend)
create or replace function leads_followup_enroll() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_enabled boolean;
  v_steps   jsonb;
  v_delay   numeric;
begin
  select enabled, steps into v_enabled, v_steps from followup_settings where id = 1;
  v_enabled := coalesce(v_enabled, false);
  -- a bad settings value must never block a lead save → safe cast, default 48h
  begin
    v_delay := (v_steps->0->>'delay_hours')::numeric;
  exception when others then
    v_delay := null;
  end;
  if v_delay is null or v_delay < 0 then v_delay := 48; end if;

  -- (a) entering Quote Sent → stamp it; enroll only while the feature is on
  if new.lead_status = 'Quote Sent'
     and (tg_op = 'INSERT' or old.lead_status is distinct from 'Quote Sent') then
    new.quote_sent_at        := now();
    new.followup_step        := 0;
    new.followup_fail_count  := 0;
    new.followup_stop_reason := null;
    new.followup_next_at     := null;
    if not v_enabled then
      new.followup_status := null;
    elsif coalesce(btrim(new.email), '') = '' then
      new.followup_status := 'no_email';
    else
      new.followup_status  := 'active';
      new.followup_next_at := now() + v_delay * interval '1 hour';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- (b) leaving Quote Sent while active → stop, unless this same statement
    --     already set the follow-up status (the engine's final Refused+completed)
    if old.lead_status = 'Quote Sent' and new.lead_status is distinct from 'Quote Sent'
       and old.followup_status = 'active'
       and new.followup_status is not distinct from old.followup_status then
      new.followup_status      := 'stopped';
      new.followup_stop_reason := 'status_changed';
      new.followup_next_at     := null;
    end if;
    -- (c) email added to a no_email lead still in Quote Sent → activate (keeps its step)
    if v_enabled and new.lead_status = 'Quote Sent'
       and old.followup_status = 'no_email' and new.followup_status is not distinct from 'no_email'
       and coalesce(btrim(old.email), '') = '' and coalesce(btrim(new.email), '') <> '' then
      new.followup_status  := 'active';
      new.followup_next_at := now() + v_delay * interval '1 hour';
    end if;
  end if;
  return new;
end
$fn$;

drop trigger if exists leads_followup_enroll on leads;
create trigger leads_followup_enroll before insert or update on leads
  for each row execute function leads_followup_enroll();

-- 6. rebuild the dashboard view so `l.*` picks up the new columns. DROP+CREATE
--    (not CREATE OR REPLACE — new columns land before paid_amount → 42P16).
--    Body copied verbatim from supabase_fix_leads_enriched_lead_id.sql.
drop view if exists leads_enriched;

create view leads_enriched
with (security_invoker = true) as
select l.*,
  r.amount           as paid_amount,
  r.payment_method   as payment_method,
  (r.id is not null) as paid,
  r.id               as revenue_record_id
from leads l
left join lateral (
  select * from revenue r
  where r.amount > 0
    and (
      r.lead_id = l.id
      or (
        r.lead_id is null
        and (
             (coalesce(l.phone_number,'') <> '' and regexp_replace(coalesce(r.phone,''),'\s','','g') = regexp_replace(l.phone_number,'\s','','g'))
          or (coalesce(l.phone_number,'') =  '' and lower(coalesce(r.client_name,'')) = lower(coalesce(l.client_name,'')))
        )
      )
    )
  order by (r.lead_id is not null) desc, r.amount desc
  limit 1
) r on true;

grant select on leads_enriched to anon, authenticated, service_role;

commit;
