-- Facebook/Instagram Lead-Ads ingestion: dedup key (Meta lead id).
-- Run once in the Supabase SQL editor (project zagmrxxmhyprhnhucqpo).
-- leads_enriched is `select l.*` so it inherits this column automatically.
alter table leads add column if not exists fb_lead_id text;
create unique index if not exists leads_fb_lead_id_key
  on leads (fb_lead_id) where fb_lead_id is not null;
