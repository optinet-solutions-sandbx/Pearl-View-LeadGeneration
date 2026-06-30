-- Phase 4 prep: disable Row Level Security so the anon key (used by the public
-- dashboard) can read AND write — matching the current posture (the Airtable
-- token is already shipped in the bundle). RLS + real policies get re-enabled
-- when we add the login in Phase 7.
alter table leads    disable row level security;
alter table revenue  disable row level security;
alter table bookings disable row level security;
alter table clients  disable row level security;
alter table expenses disable row level security;
