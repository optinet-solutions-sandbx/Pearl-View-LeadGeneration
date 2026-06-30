-- Pearl View — Supabase schema (Phase 1 of the Airtable→Supabase migration)
-- Run once in Supabase → SQL Editor → New query → paste → Run.

create extension if not exists pgcrypto;

-- ── leads ────────────────────────────────────────────────────────────────────
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  client_name text,
  phone_number text,
  caller_id text,
  email text,
  lead_source text,
  call_lead_source text,
  lead_status text not null default 'New Lead',
  call_time timestamptz,
  call_recording_transcript text,
  inquiry_date timestamptz,
  inquiry_subject text,
  service_address text,
  address text,                       -- the Airtable 'Adress' (sic) field
  property_type text,                 -- primary job type (single)
  services text[] default '{}',       -- multi-select job types
  estimated_window_count int,
  stories int,
  quote_amount numeric,
  final_invoice_amount numeric,
  call_duration text,
  next_follow_up_date date,
  scheduled_cleaning_date date,
  property_details text,
  notes text,
  refusal_reason text,
  city text,
  invoice_number int,
  invoice_sent boolean default false,
  airtable_id text,                   -- original Airtable recXXX (migration trace)
  created_at timestamptz default now()
);
create index if not exists leads_phone_idx  on leads (phone_number);
create index if not exists leads_status_idx on leads (lead_status);

-- ── revenue (payment source of truth) ─────────────────────────────────────────
create table if not exists revenue (
  id uuid primary key default gen_random_uuid(),
  revenue_name text, date date, client_name text, phone text,
  job_service text, city text, payment_method text,
  amount numeric, status text,
  lead_id uuid references leads(id) on delete set null,
  airtable_id text,
  created_at timestamptz default now()
);
create index if not exists revenue_phone_idx on revenue (phone);

-- ── bookings ──────────────────────────────────────────────────────────────────
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  booking_name text, client_name text, phone text, city text,
  job_service text, date timestamptz, booking_status text,
  amount numeric, job_time text, assigned_worker text,
  upsell_amount numeric, upsell_notes text,
  lead_id uuid references leads(id) on delete set null,   -- fixes the null-on-reload link
  airtable_id text,
  created_at timestamptz default now()
);
create index if not exists bookings_date_idx on bookings (date);

-- ── clients ───────────────────────────────────────────────────────────────────
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  client_name text, phone_number text, email text, address text,
  city text, notes text, property_type text, lead_source text,
  status text, airtable_id text, created_at timestamptz default now()
);
create index if not exists clients_phone_idx on clients (phone_number);

-- ── expenses ──────────────────────────────────────────────────────────────────
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  expense_name text, date date, category text,
  amount numeric, description text, airtable_id text,
  created_at timestamptz default now()
);

-- ── invoice numbering (replaces the full-table scan) ──────────────────────────
create or replace function next_invoice_number()
returns int language sql as $$
  select greatest(coalesce(max(invoice_number), 0), 209) + 1 from leads;
$$;

-- ── enrichment view: leads + highest matching revenue (reproduces fetchLeads) ─
create or replace view leads_enriched as
select l.*,
  r.amount         as paid_amount,
  r.payment_method as payment_method,
  (r.id is not null) as paid,
  r.id             as revenue_record_id
from leads l
left join lateral (
  select * from revenue r
  where r.amount > 0
    and ( (coalesce(l.phone_number,'') <> '' and regexp_replace(coalesce(r.phone,''),'\s','','g') = regexp_replace(l.phone_number,'\s','','g'))
       or (coalesce(l.phone_number,'') = '' and lower(coalesce(r.client_name,'')) = lower(coalesce(l.client_name,''))) )
  order by r.amount desc
  limit 1
) r on true;
