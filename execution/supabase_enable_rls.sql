-- Phase 7 final step: re-enable Row Level Security so ONLY logged-in
-- (authenticated) users can read/write. The anon key in the bundle is then
-- powerless on its own. The backend uses service_role, which bypasses RLS.
-- Run once in Supabase → SQL Editor → Run, AFTER the login is deployed.

-- View must respect the caller's RLS (else anon could read it).
alter view leads_enriched set (security_invoker = true);

do $$
declare t text;
begin
  foreach t in array array['leads','revenue','bookings','clients','expenses'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists pv_auth_all on %I', t);
    execute format('create policy pv_auth_all on %I for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;
