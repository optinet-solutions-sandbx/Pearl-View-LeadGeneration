-- Technician dashboard: role-scoped access. Run ONCE per branch SQL editor.
-- Sequencing matters: profiles + owner row + is_owner() are created BEFORE the
-- policy swap so the owner never loses access.
begin;

-- 1. profiles (one row per login)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'technician' check (role in ('owner','technician')),
  display_name text,
  active boolean not null default true,
  created_at timestamptz default now()
);
alter table profiles enable row level security;

-- 2. booking scoping key + tech-facing detail columns
alter table bookings add column if not exists assigned_worker_id uuid references profiles(id) on delete set null;
alter table bookings add column if not exists tech_notes text;
-- service_address: the job address the technician needs (leads table is RLS-blocked
--   for techs, so it must live on the booking). owner-controlled (in the guard tuple).
alter table bookings add column if not exists service_address text;
-- tech_completed_at: set when a technician marks their job done → owner sees
--   "done by tech, needs invoicing". NOT in the guard tuple (techs may set it).
alter table bookings add column if not exists tech_completed_at timestamptz;

-- 3. owner helper — SECURITY DEFINER so reading profiles inside the policy
--    doesn't recurse through profiles' own RLS.
create or replace function is_owner() returns boolean
  language sql security definer stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner' and active);
$$;

-- 4. seed the owner profile from the existing owner auth user.
--    NSW: pearlview@pearlview.app   Perth: perthview@perthview.app  (EDIT per branch)
insert into profiles (id, role, display_name)
select id, 'owner', 'Owner' from auth.users where email = 'pearlview@pearlview.app'
on conflict (id) do update set role = 'owner', active = true;

-- 5. column guard: a LOGGED-IN non-owner (i.e. a technician) may change ONLY
--    booking_status + tech_notes. The backend (service_role) has no auth.uid(),
--    so it is exempt — otherwise the trigger would block all server-side booking
--    writes (createBooking is an INSERT so it's already unaffected, but future
--    backend UPDATEs must not be blocked). Owner (is_owner) is exempt too.
create or replace function bookings_tech_guard() returns trigger
  language plpgsql security definer as $$
begin
  if auth.uid() is not null and not is_owner() then
    if (new.booking_name, new.client_name, new.phone, new.city, new.job_service,
        new.date, new.amount, new.job_time, new.assigned_worker, new.upsell_amount,
        new.upsell_notes, new.lead_id, new.assigned_worker_id, new.service_address)
       is distinct from
       (old.booking_name, old.client_name, old.phone, old.city, old.job_service,
        old.date, old.amount, old.job_time, old.assigned_worker, old.upsell_amount,
        old.upsell_notes, old.lead_id, old.assigned_worker_id, old.service_address) then
      raise exception 'technicians may only update booking_status, tech_notes and completion time';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bookings_tech_guard_trg on bookings;
create trigger bookings_tech_guard_trg before update on bookings
  for each row execute function bookings_tech_guard();

-- 6. RLS swap: drop the blanket policy, add role-aware policies.
drop policy if exists pv_auth_all on leads;
drop policy if exists pv_auth_all on revenue;
drop policy if exists pv_auth_all on clients;
drop policy if exists pv_auth_all on expenses;
drop policy if exists pv_auth_all on bookings;

create policy owner_all on leads    for all using (is_owner()) with check (is_owner());
create policy owner_all on revenue  for all using (is_owner()) with check (is_owner());
create policy owner_all on clients  for all using (is_owner()) with check (is_owner());
create policy owner_all on expenses for all using (is_owner()) with check (is_owner());

create policy profiles_read  on profiles for select using (id = auth.uid() or is_owner());
create policy profiles_write on profiles for all using (is_owner()) with check (is_owner());

create policy bookings_owner    on bookings for all    using (is_owner()) with check (is_owner());
create policy bookings_tech_sel on bookings for select using (assigned_worker_id = auth.uid());
create policy bookings_tech_upd on bookings for update using (assigned_worker_id = auth.uid()) with check (assigned_worker_id = auth.uid());

-- 7. Read-only lead visibility for technicians (Quote Sent / Booked / Job Done).
--    A SECURITY DEFINER view (default, no security_invoker) so it bypasses RLS and
--    exposes ONLY the safe columns below — NO money (quote/invoice), NO internal
--    notes / call recording / refusal reason. Techs get NO RLS policy on the base
--    leads table, so they can read leads ONLY through this column-limited view;
--    a direct query on `leads` still returns nothing for them (money stays hidden).
drop view if exists tech_leads;
create view tech_leads as
  select id, client_name, phone_number, email, lead_status, inquiry_subject, inquiry_date,
         property_type, services, estimated_window_count, stories, property_details,
         service_address, address, city, next_follow_up_date, scheduled_cleaning_date, lead_source
  from leads
  where lead_status in ('Quote Sent', 'Booked', 'Job Done');
grant select on tech_leads to authenticated;

commit;
