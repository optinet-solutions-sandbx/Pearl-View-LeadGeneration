# Technician Dashboard — Role-Scoped Bookings View

**Date:** 2026-07-23
**Status:** Design — awaiting user approval

## Goal

Give each field technician their own login that shows **only the bookings assigned to them**, where they can **view job details, mark a job completed, and add a note** — and nothing else (no leads pipeline, no revenue, no pricing, no other techs' jobs). Enforced at the database (RLS), not just hidden in the UI. Ships to **both** branches (NSW + Perth) from the one config-driven codebase.

## Context

- Auth today: Supabase Auth, a **single owner login** per branch (`pearlview` / `perthview`). RLS is a blanket `pv_auth_all` policy = any authenticated user reads/writes everything. Backend uses `service_role` (bypasses RLS).
- `bookings.assigned_worker` exists but is **free-text and sparse** (14/201 NSW rows; values like `Rahda`, `Asaf`, `Zak`, and a typo `ok`) — not a safe scoping key. This build formalizes assignment via a real id link.
- Two branches, separate Supabase DBs (NSW `zagmrxxmhyprhnhucqpo`, Perth `tawsrgbadjxqcorqfaxi`), one shared frontend/back­end codebase.

## Approach: role-based access enforced by RLS

A `profiles` table tags each auth user as **owner** or **technician**. RLS policies are rewritten to be role-aware so a technician can only ever read/act on their own assigned bookings and cannot read any other table. Rejected: *app-only filtering* (a tech's JWT could still read everything through the REST API — not actually private) and a *separate technician app* (duplicates auth + deploy for no gain).

## Data model (apply to each branch DB)

- **`profiles`** — one row per login:
  ```sql
  create table if not exists profiles (
    id uuid primary key references auth.users(id) on delete cascade,
    role text not null default 'technician' check (role in ('owner','technician')),
    display_name text,
    active boolean not null default true,
    created_at timestamptz default now()
  );
  ```
- **`bookings.assigned_worker_id uuid references profiles(id) on delete set null`** — the reliable scoping key. The existing free-text `assigned_worker` stays for display; assignment writes both (id + name).
- **`bookings.tech_notes text`** — where a technician's note is saved (kept separate from owner `upsell_notes`).
- The existing owner auth user gets a `profiles` row with `role='owner'`; each technician gets `role='technician'`.

## RLS (the security core)

A `SECURITY DEFINER` helper avoids policy recursion when reading `profiles`:
```sql
create or replace function is_owner() returns boolean
  language sql security definer stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner' and active);
$$;
```

Policy changes (replacing blanket `pv_auth_all`):
- **`profiles`**: SELECT `using (id = auth.uid() or is_owner())`; write `using (is_owner()) with check (is_owner())`. (Provisioning uses `service_role`, which bypasses.)
- **`leads`, `revenue`, `clients`, `expenses`**: all commands `using (is_owner()) with check (is_owner())` — **owner only; technicians get zero rows.**
- **`bookings`**:
  - Owner: all commands `using (is_owner()) with check (is_owner())`.
  - Technician SELECT: `using (assigned_worker_id = auth.uid())`.
  - Technician UPDATE: `using (assigned_worker_id = auth.uid()) with check (assigned_worker_id = auth.uid())`.
  - No INSERT/DELETE for technicians.
- **Column protection for technicians** — a `BEFORE UPDATE` trigger rejects any change by a non-owner to columns other than `booking_status` and `tech_notes` (so a tech can't alter amount/date/client/assignment even on their own row via a raw API call):
  ```sql
  create or replace function bookings_tech_guard() returns trigger
    language plpgsql security definer as $$
  begin
    if not is_owner() then
      if (new.amount, new.client_name, new.phone, new.date, new.job_service, new.assigned_worker_id) is distinct from
         (old.amount, old.client_name, old.phone, old.date, old.job_service, old.assigned_worker_id) then
        raise exception 'technicians may only update booking_status and tech_notes';
      end if;
    end if;
    return new;
  end $$;
  create trigger bookings_tech_guard_trg before update on bookings
    for each row execute function bookings_tech_guard();
  ```
- `service_role` bypasses all of the above → the whatsapp-service backend is unchanged.

**Sequencing (critical):** create `profiles` + insert the owner's `role='owner'` row + create `is_owner()` **before** swapping the policies, so the owner never loses access. Verify owner access immediately after.

## Frontend

- **Role routing** (`App.jsx` AuthGate): after login, read the caller's own `profiles` row. `role='owner'` → the existing dashboard (unchanged). `role='technician'` → the new `TechnicianView`. A missing/inactive profile → signed-out with a clear message.
- **`TechnicianView.jsx`** (new, mobile-first): the tech's assigned, non-cancelled bookings grouped by date (upcoming first). Each card: client name, **address**, **tap-to-call phone**, time, service, `tech_notes`. Actions: **"Mark Completed"** (sets `booking_status='Completed'`) and **"Add Note"** (writes `tech_notes`). No amounts, no leads, no revenue. Reads/writes go through the session JWT so RLS scopes automatically.
- **Owner assignment control**: in the booking editor (`EditBookingModal` / `addCalBooking` path), replace the free-text `assigned_worker` input with a **dropdown of technician profiles**; saving writes `assigned_worker_id` (+ `assigned_worker` name for display).
- Small data layer: a `useTechnicianBookings` hook (or a scoped branch in the existing hook) exposing `myBookings`, `markCompleted(id)`, `saveTechNote(id, note)`.

## Provisioning

- `execution/create_technician.mjs` (Node, `service_role`, `ENV_FILE` to target NSW or Perth): creates a Supabase Auth user (Admin API) + a `profiles` row (`role='technician'`, `display_name`). Also a one-time step to insert the owner's `role='owner'` profile per branch. No public sign-up.

## Both branches

Same code. Each branch DB gets: the `profiles` table, `assigned_worker_id` + `tech_notes` columns, `is_owner()`, the trigger, and the RLS swap (run in each SQL editor). Technician accounts created per branch with the provisioning script. NSW and Perth are independent (separate accounts, separate data).

## Rollout (phased)

1. **DB foundation** (per branch SQL editor): `profiles` + columns + `is_owner()` + owner profile row + trigger + RLS swap. Verify owner still has full access and a test technician row sees only its bookings.
2. **Frontend role routing + `TechnicianView`** (view + mark done + notes).
3. **Owner assignment dropdown** (write `assigned_worker_id`).
4. **Provision technician accounts** per branch.

Each phase ships independently; owner experience is unchanged throughout.

## Testing

- **RLS (critical, automated via a script with a technician JWT):** a technician token returns **only** their assigned bookings, **zero rows** from leads/revenue/clients/expenses, cannot UPDATE another tech's booking, and cannot change a protected column on their own booking (trigger raises). Owner token still reads/writes everything.
- **Frontend:** technician login → only their jobs, grouped by date, no pricing; Mark Completed flips status and it reflects on the owner's calendar; Add Note persists. Owner login unchanged; assignment dropdown writes the id.
- Build passes; run against a test technician account before creating real ones.

## Edge cases

- Booking with no `assigned_worker_id` → invisible to all technicians (owner-only) — expected.
- Technician marks Completed → booking `Completed` only; **no** payment/invoice side-effect (owner handles money). If the booking is lead-linked, the owner's existing flow/audit reconciles the lead later.
- Reassigning a booking to another tech → it leaves the first tech's view (RLS is live).
- Inactive/removed tech (`active=false` or profile deleted) → loses access; their past bookings remain (owner sees them).

## Out of scope (YAGNI)

- Technician self-sign-up / password reset UI (owner/admin provisions accounts).
- Technician access to leads, revenue, clients, expenses, invoicing, or any pricing.
- Scheduling/route optimization, push notifications, photo uploads.
- Migrating the 14 legacy free-text `assigned_worker` values (owner re-assigns via the new dropdown as needed; not auto-mapped — names are ambiguous).

## Files affected

- **Create:** `execution/supabase_technician_rls.sql` (profiles + columns + is_owner + trigger + RLS swap), `execution/create_technician.mjs` (provisioning), `execution/test_technician_rls.mjs` (RLS security test), `src/components/pages/TechnicianView.jsx`, `src/hooks/useTechnicianBookings.js`.
- **Modify:** `src/App.jsx` (role routing), `src/utils/supabaseClient.js` (fetch current profile; `BOOKING_COLS` += `assigned_worker_id`, `tech_notes`), `whatsapp-service/sb.js` (`BOOKING_COLS` += same, for consistency), the booking editor component (`assigned_worker` dropdown), `execution/supabase_schema.sql` (document the new table/columns).
