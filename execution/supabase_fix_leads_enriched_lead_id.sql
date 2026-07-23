-- Fix: same-named / phone-less leads sharing one payment.
--
-- Root cause: leads_enriched matched revenue to a lead by phone, or by Client
-- Name when the lead was phone-less — ignoring revenue.lead_id. So two phone-less
-- leads with the same name both resolved to the SAME revenue row, showing the
-- same "Paid $X" and updating together.
--
-- Fix: prefer an explicit revenue.lead_id link. Fall back to phone/name ONLY for
-- legacy revenue rows that have no lead_id, and never let a lead match a revenue
-- row that is explicitly linked to a different lead.
--
-- NOTE: uses DROP + CREATE (not CREATE OR REPLACE) because the leads table gained
-- an fb_lead_id column, so `l.*` shifts the view's appended columns and
-- CREATE OR REPLACE errors (42P16 "cannot change name of view column"). Wrapped
-- in a transaction so there is no window where the view is missing, and grants
-- are re-applied so the dashboard (anon/authenticated) can still read it.
--
-- Run once in the Supabase SQL editor (project zagmrxxmhyprhnhucqpo).
begin;

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
  order by (r.lead_id is not null) desc, r.amount desc   -- explicit lead link wins, then highest amount
  limit 1
) r on true;

grant select on leads_enriched to anon, authenticated, service_role;

commit;
