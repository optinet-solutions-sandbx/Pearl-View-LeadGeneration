# Technician Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each field technician a login that shows only their assigned bookings (view + mark completed + add note), enforced by Postgres RLS, on both branches.

**Architecture:** A `profiles` table tags each auth user owner/technician. RLS policies (replacing the blanket `pv_auth_all`) scope technicians to their own `bookings` rows and block every other table; a trigger limits their edits to status + notes. The React frontend routes by role at login: owner → existing dashboard, technician → a mobile-first `TechnicianView`. Backend (`service_role`) is unchanged.

**Tech Stack:** React 18 + Vite; Supabase Postgres + Auth (RLS, Admin API); Node ESM scripts using global `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-23-technician-dashboard-design.md`

## Global Constraints

- **No new npm dependencies.** Scripts are Node ESM (`.mjs`) using global `fetch`; they read creds from an env file (`ENV_FILE` override → target NSW or Perth), never printing secrets.
- **Security is DB-enforced, not UI-only.** A technician JWT must return only their bookings and **zero** rows from `leads`/`revenue`/`clients`/`expenses`.
- **Owner access must never break.** Seed the owner `profiles` row and create `is_owner()` BEFORE swapping RLS policies; verify owner access right after.
- **Techs edit only `booking_status` + `tech_notes`** (row-level via RLS, column-level via the `bookings_tech_guard` trigger). No pricing/leads/revenue exposure.
- **DDL runs in each branch's SQL editor** (NSW `zagmrxxmhyprhnhucqpo`, Perth `tawsrgbadjxqcorqfaxi`) — it can't be applied over PostgREST. Owner emails: NSW `pearlview@pearlview.app`, Perth `perthview@perthview.app`.
- **Roles/values:** profile role ∈ {`owner`,`technician`}; booking status ∈ {`Scheduled`,`Completed`,`Cancelled`}. Current blanket policy name is `pv_auth_all`.
- **Both branches** get the feature from the one codebase. **Never push/deploy without explicit user approval.**

---

## File Structure

- **Create** `execution/supabase_technician_rls.sql` — profiles table, `assigned_worker_id`+`tech_notes` columns, `is_owner()`, `bookings_tech_guard` trigger, owner seed, RLS swap. Run once per branch.
- **Create** `execution/create_technician.mjs` — provision a technician (Auth Admin API + profiles row); `ENV_FILE` targets a branch.
- **Create** `execution/test_technician_rls.mjs` — signs in as a technician + as owner, asserts the scoping at the REST layer.
- **Create** `src/hooks/useTechnicianBookings.js` — technician data layer (`myBookings`, `markCompleted`, `saveTechNote`).
- **Create** `src/components/pages/TechnicianView.jsx` — the mobile-first technician screen.
- **Modify** `src/utils/supabaseClient.js` — `fetchCurrentProfile()`; `BOOKING_COLS` += `assigned_worker_id`, `tech_notes`.
- **Modify** `src/App.jsx` — role routing after auth.
- **Modify** the booking editor in `src/components/pages/CalendarPage.jsx` (`EditBookingModal`) — worker dropdown from technician profiles.
- **Modify** `whatsapp-service/sb.js` — `BOOKING_COLS` += `assigned_worker_id`, `tech_notes` (consistency).

**Shipping phases:** Task 1–3 = DB foundation + verification. Task 4–6 = frontend. Task 7 = provision + deploy. Each ships independently; owner UX unchanged throughout.

---

## Task 1: DB foundation — schema, RLS, trigger (DDL file) + column mappings

**Files:**
- Create: `execution/supabase_technician_rls.sql`
- Modify: `src/utils/supabaseClient.js` (`BOOKING_COLS`), `whatsapp-service/sb.js` (`BOOKING_COLS`)

**Interfaces:**
- Produces: `profiles(id,role,display_name,active)`; `bookings.assigned_worker_id`, `bookings.tech_notes`; SQL fn `is_owner()`; RLS policies. Frontend/back­end `BOOKING_COLS` map `'Assigned Worker Id'→assigned_worker_id`, `'Tech Notes'→tech_notes`.

- [ ] **Step 1: Write the DDL**

Create `execution/supabase_technician_rls.sql`:

```sql
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

-- 2. booking scoping key + tech note column
alter table bookings add column if not exists assigned_worker_id uuid references profiles(id) on delete set null;
alter table bookings add column if not exists tech_notes text;

-- 3. owner helper — SECURITY DEFINER so reading profiles inside the policy
--    doesn't recurse through profiles' own RLS.
create or replace function is_owner() returns boolean
  language sql security definer stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'owner' and active);
$$;

-- 4. seed the owner profile from the existing owner auth user.
--    NSW: pearlview@pearlview.app   Perth: perthview@perthview.app  (edit per branch)
insert into profiles (id, role, display_name)
select id, 'owner', 'Owner' from auth.users where email = 'pearlview@pearlview.app'
on conflict (id) do update set role = 'owner', active = true;

-- 5. column guard: a non-owner may change ONLY booking_status + tech_notes.
create or replace function bookings_tech_guard() returns trigger
  language plpgsql security definer as $$
begin
  if not is_owner() then
    if (new.booking_name, new.client_name, new.phone, new.city, new.job_service,
        new.date, new.amount, new.job_time, new.assigned_worker, new.upsell_amount,
        new.upsell_notes, new.lead_id, new.assigned_worker_id)
       is distinct from
       (old.booking_name, old.client_name, old.phone, old.city, old.job_service,
        old.date, old.amount, old.job_time, old.assigned_worker, old.upsell_amount,
        old.upsell_notes, old.lead_id, old.assigned_worker_id) then
      raise exception 'technicians may only update booking_status and tech_notes';
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

commit;
```

- [ ] **Step 2: Add the column mappings (frontend + backend)**

In `src/utils/supabaseClient.js`, add to `BOOKING_COLS` (before the closing brace):
```js
  'Assigned Worker Id': 'assigned_worker_id', 'Tech Notes': 'tech_notes',
```
Do the same in `whatsapp-service/sb.js` `BOOKING_COLS`.

- [ ] **Step 3: Verify mappings + build**

Run: `node -e "const s=require('fs').readFileSync('src/utils/supabaseClient.js','utf8'); if(!/'Assigned Worker Id':\s*'assigned_worker_id'/.test(s))throw new Error('missing'); console.log('PASS: booking cols mapped')"`
Expected: PASS.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add execution/supabase_technician_rls.sql src/utils/supabaseClient.js whatsapp-service/sb.js
git commit -m "feat(technician): DB foundation DDL (profiles + RLS + trigger) and booking column maps"
```

> The DDL is **run by the user** in each branch SQL editor during Task 7 (can't apply over the API). Steps 2–3 are safe to ship anytime (adding column mappings is backward-compatible).

---

## Task 2: Technician provisioning script

**Files:**
- Create: `execution/create_technician.mjs`

**Interfaces:**
- Produces: creates one auth user + a `profiles` row (`role='technician'`). CLI: `ENV_FILE=… node execution/create_technician.mjs --email <e> --password <p> --name "<n>"`.

- [ ] **Step 1: Write the script**

Create `execution/create_technician.mjs`:

```js
/* Provision a technician: Supabase Auth user + profiles row (role=technician).
   Usage: ENV_FILE=whatsapp-service/.env.perth node execution/create_technician.mjs \
            --email tech1@perthview.app --password 'Temp#2026' --name "Zak"
   Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE from ENV_FILE (default .env). */
import { readFileSync } from 'node:fs';

const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const email = arg('--email'), password = arg('--password'), name = arg('--name');
if (!email || !password || !name) { console.error('need --email --password --name'); process.exit(1); }

const env = Object.fromEntries(readFileSync(process.env.ENV_FILE || '.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// 1. create the auth user (email confirmed so they can log in immediately)
const cu = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: H,
  body: JSON.stringify({ email, password, email_confirm: true }) });
const user = await cu.json();
const uid = user.id || user.user?.id;
if (!uid) { console.error('create user FAILED:', cu.status, JSON.stringify(user).slice(0, 300)); process.exit(1); }

// 2. profiles row (role=technician)
const cp = await fetch(`${URL}/rest/v1/profiles`, { method: 'POST',
  headers: { ...H, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({ id: uid, role: 'technician', display_name: name, active: true }) });
console.log(`technician ${name} <${email}> -> ${uid} (profiles ${cp.status})`);
```

- [ ] **Step 2: Sanity-check it parses**

Run: `node --check execution/create_technician.mjs && echo "PASS: syntax"`
Expected: PASS. (It is actually run against a DB in Task 7, after the DDL exists.)

- [ ] **Step 3: Commit**

```bash
git add execution/create_technician.mjs
git commit -m "feat(technician): provisioning script (auth user + technician profile)"
```

---

## Task 3: RLS security test

**Files:**
- Create: `execution/test_technician_rls.mjs`

**Interfaces:**
- Consumes: a test technician account (created in Task 7 dry-run), the branch env file. CLI: `ENV_FILE=… TECH_EMAIL=… TECH_PASSWORD=… node execution/test_technician_rls.mjs`.

- [ ] **Step 1: Write the test**

Create `execution/test_technician_rls.mjs`:

```js
/* Prove technician RLS scoping at the REST layer.
   ENV_FILE=... TECH_EMAIL=... TECH_PASSWORD=... node execution/test_technician_rls.mjs
   Signs in as the technician (anon key) → asserts: sees only own bookings, 0 rows
   from leads/revenue/clients/expenses. Exit 0 = pass. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert';

const env = Object.fromEntries(readFileSync(process.env.ENV_FILE || '.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const ANON = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
const EMAIL = process.env.TECH_EMAIL, PW = process.env.TECH_PASSWORD;
if (!URL || !ANON || !EMAIL || !PW) { console.error('need URL, ANON key, TECH_EMAIL, TECH_PASSWORD'); process.exit(1); }

// sign in as the technician → JWT
const si = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PW }) });
const tok = (await si.json()).access_token;
assert.ok(tok, 'technician sign-in should return a token');
const H = { apikey: ANON, Authorization: `Bearer ${tok}` };
const rows = async t => { const r = await fetch(`${URL}/rest/v1/${t}?select=id`, { headers: H }); return r.ok ? (await r.json()).length : `ERR ${r.status}`; };

const bookings = await rows('bookings');
console.log('technician sees bookings:', bookings);
for (const t of ['leads', 'revenue', 'clients', 'expenses']) {
  const n = await rows(t);
  assert.strictEqual(n, 0, `technician must see 0 ${t} rows (got ${n})`);
  console.log(`  ${t}: ${n} ✓`);
}
console.log('PASS: technician is scoped (bookings only, no leads/revenue/clients/expenses)');
```

- [ ] **Step 2: Syntax-check**

Run: `node --check execution/test_technician_rls.mjs && echo "PASS: syntax"`
Expected: PASS. (Full run happens in Task 7 once the DDL + a test technician exist.)

- [ ] **Step 3: Commit**

```bash
git add execution/test_technician_rls.mjs
git commit -m "feat(technician): RLS security test (technician JWT scoping)"
```

---

## Task 4: Frontend role routing

**Files:**
- Modify: `src/utils/supabaseClient.js` (add `fetchCurrentProfile`), `src/App.jsx`

**Interfaces:**
- Produces: `fetchCurrentProfile() → Promise<{id,role,display_name,active}|null>`. `App.jsx` renders `TechnicianView` when `role==='technician'`, else the existing dashboard.

- [ ] **Step 1: Add `fetchCurrentProfile` to `supabaseClient.js`**

```js
// Read the logged-in user's profile (role gate). RLS lets a user read their own row.
export async function fetchCurrentProfile() {
  const r = await fetch(`${SB_URL}/rest/v1/profiles?select=id,role,display_name,active`, { headers: hdr() });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0] || null;
}
```
(Use the file's existing base-URL const + `hdr()` session-JWT helper — match the names already in `supabaseClient.js`.)

- [ ] **Step 2: Route by role in `App.jsx`**

Read `src/App.jsx` first to find the post-auth render point (the AuthGate that renders the dashboard once a session exists). After a session is confirmed, load the profile and branch:
```js
// inside the authenticated branch, after session is set:
const [profile, setProfile] = useState(undefined); // undefined = loading
useEffect(() => { if (session) fetchCurrentProfile().then(setProfile); }, [session]);
if (session && profile === undefined) return <FullScreenLoader />;      // existing loader/spinner
if (session && profile?.role === 'technician') return <TechnicianView profile={profile} />;
// else fall through to the existing owner dashboard render
```
Import `fetchCurrentProfile` and `TechnicianView`. Keep the existing owner path exactly as-is.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0. (`TechnicianView` may be a minimal stub until Task 5 — a component returning a placeholder is fine to compile.)

- [ ] **Step 4: Commit**

```bash
git add src/utils/supabaseClient.js src/App.jsx
git commit -m "feat(technician): role routing at login (owner dashboard vs TechnicianView)"
```

---

## Task 5: TechnicianView + data hook

**Files:**
- Create: `src/hooks/useTechnicianBookings.js`, `src/components/pages/TechnicianView.jsx`

**Interfaces:**
- Consumes: session JWT via `supabaseClient` (RLS scopes reads/writes). Produces: `useTechnicianBookings() → { myBookings, loading, markCompleted(id), saveTechNote(id, note), refresh }`; `TechnicianView` renders them.

- [ ] **Step 1: Write the hook**

Create `src/hooks/useTechnicianBookings.js`:
```js
import { useState, useEffect, useCallback } from 'react';
import { sbSelect } from '../utils/supabaseClient';  // existing scoped-fetch helper
import { updateRecord, AT_TABLES } from '../utils/airtableSync';

// RLS already limits these rows to the logged-in technician's own bookings.
export function useTechnicianBookings() {
  const [myBookings, setMyBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    const rows = await sbSelect('bookings?select=*&order=date.asc');
    setMyBookings((rows || []).filter(b => b.booking_status !== 'Cancelled').map(b => ({
      id: b.id, name: b.client_name, phone: b.phone, city: b.city, address: b.city,
      service: b.job_service, date: b.date ? String(b.date).slice(0, 10) : '',
      time: b.job_time, status: b.booking_status, notes: b.tech_notes || '',
    })));
    setLoading(false);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  const markCompleted = useCallback(async (id) => {
    await updateRecord(AT_TABLES.calendar, id, { 'Booking Status': 'Completed' });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, status: 'Completed' } : b));
  }, []);
  const saveTechNote = useCallback(async (id, note) => {
    await updateRecord(AT_TABLES.calendar, id, { 'Tech Notes': note });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, notes: note } : b));
  }, []);
  return { myBookings, loading, markCompleted, saveTechNote, refresh };
}
```
(Confirm `sbSelect`/`updateRecord` signatures in the repo; both are already used in `useLeads.js`.)

- [ ] **Step 2: Write `TechnicianView.jsx`**

Create `src/components/pages/TechnicianView.jsx` — mobile-first, grouped by date, no pricing:
```jsx
import { useState } from 'react';
import { useTechnicianBookings } from '../../hooks/useTechnicianBookings';
import { signOut } from '../../utils/supabaseClient'; // existing logout helper

export default function TechnicianView({ profile }) {
  const { myBookings, loading, markCompleted, saveTechNote } = useTechnicianBookings();
  const [noteFor, setNoteFor] = useState(null);
  const [draft, setDraft] = useState('');
  const byDate = myBookings.reduce((m, b) => { (m[b.date] ||= []).push(b); return m; }, {});
  const dates = Object.keys(byDate).sort();
  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 16, fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div><div style={{ fontWeight: 800 }}>My Jobs</div><div style={{ color: '#666', fontSize: 13 }}>{profile.display_name}</div></div>
        <button onClick={signOut} style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, background: '#fff' }}>Sign out</button>
      </header>
      {loading && <p>Loading…</p>}
      {!loading && !dates.length && <p style={{ color: '#666' }}>No jobs assigned to you yet.</p>}
      {dates.map(d => (
        <section key={d} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0f766e', textTransform: 'uppercase', margin: '8px 0' }}>
            {new Date(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
          </div>
          {byDate[d].map(b => (
            <div key={b.id} style={{ border: '1px solid #eee', borderRadius: 12, padding: 14, marginBottom: 10, background: b.status === 'Completed' ? '#f0fdf4' : '#fff' }}>
              <div style={{ fontWeight: 700 }}>{b.name}</div>
              <div style={{ color: '#555', fontSize: 14 }}>{b.service}{b.time ? ` · ${b.time}` : ''}</div>
              {b.address && <div style={{ fontSize: 14, marginTop: 4 }}>{b.address}</div>}
              {b.phone && <a href={`tel:${b.phone}`} style={{ fontSize: 14, color: '#3b5bdb' }}>{b.phone}</a>}
              {b.notes && <div style={{ fontSize: 13, color: '#666', marginTop: 6, whiteSpace: 'pre-wrap' }}>📝 {b.notes}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {b.status !== 'Completed' && <button onClick={() => markCompleted(b.id)} style={{ flex: 1, padding: 10, background: '#0f766e', color: '#fff', border: 0, borderRadius: 8, fontWeight: 700 }}>Mark Completed</button>}
                <button onClick={() => { setNoteFor(b.id); setDraft(b.notes); }} style={{ flex: 1, padding: 10, background: '#fff', border: '1px solid #ddd', borderRadius: 8 }}>Add Note</button>
              </div>
              {noteFor === b.id && (
                <div style={{ marginTop: 8 }}>
                  <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} style={{ width: '100%', boxSizing: 'border-box' }} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button onClick={async () => { await saveTechNote(b.id, draft); setNoteFor(null); }} style={{ padding: '8px 14px', background: '#0f766e', color: '#fff', border: 0, borderRadius: 8 }}>Save</button>
                    <button onClick={() => setNoteFor(null)} style={{ padding: '8px 14px', background: '#fff', border: '1px solid #ddd', borderRadius: 8 }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
```
(Match `signOut`/`sbSelect` to the actual exports in `supabaseClient.js`; if a `city`/address split exists, map the real address field. This component may be polished later with the frontend-design skill — logic first.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useTechnicianBookings.js src/components/pages/TechnicianView.jsx
git commit -m "feat(technician): TechnicianView + useTechnicianBookings (view, mark done, note)"
```

---

## Task 6: Owner assignment dropdown

**Files:**
- Modify: `src/components/pages/CalendarPage.jsx` (`EditBookingModal`), `src/utils/supabaseClient.js` (a `fetchTechnicians` helper)

**Interfaces:**
- Consumes: `profiles` (owner reads all via RLS). Produces: assigning a booking writes `assigned_worker_id` (+ `assigned_worker` display name).

- [ ] **Step 1: Add `fetchTechnicians` to `supabaseClient.js`**
```js
export async function fetchTechnicians() {
  const r = await fetch(`${SB_URL}/rest/v1/profiles?role=eq.technician&active=eq.true&select=id,display_name`, { headers: hdr() });
  return r.ok ? await r.json() : [];
}
```

- [ ] **Step 2: Use it in `EditBookingModal`**

Read `EditBookingModal` in `CalendarPage.jsx`. Load technicians on mount (`useEffect(() => { fetchTechnicians().then(setTechs); }, [])`), and replace the free-text `assignedWorker` input with a `<select>`:
```jsx
<select value={form.assignedWorkerId || ''} onChange={e => {
  const t = techs.find(x => x.id === e.target.value);
  setForm(f => ({ ...f, assignedWorkerId: e.target.value, assignedWorker: t?.display_name || '' }));
}}>
  <option value="">— Unassigned —</option>
  {techs.map(t => <option key={t.id} value={t.id}>{t.display_name}</option>)}
</select>
```
On save, include both `'Assigned Worker Id': form.assignedWorkerId || null` and `'Assigned Worker': form.assignedWorker` in the fields passed to `updateCalBooking`/`addCalBooking`. Ensure `normaliseCalBooking` surfaces `assignedWorkerId` from `f['Assigned Worker Id']` (add that line next to the existing `linkedLeadId`).

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/components/pages/CalendarPage.jsx src/utils/supabaseClient.js
git commit -m "feat(technician): owner assigns bookings to technicians via dropdown (writes assigned_worker_id)"
```

---

## Task 7: Provision + deploy (runbook, per branch)

This task needs the user (SQL editor, push approval). Do not deploy without explicit approval.

- [ ] **Step 1: Run the DDL (USER, each branch SQL editor)**

Paste `execution/supabase_technician_rls.sql` into NSW's SQL editor (`zagmrxxmhyprhnhucqpo`), then edit the owner email to `perthview@perthview.app` and run it in Perth's (`tawsrgbadjxqcorqfaxi`). Expected: "Success. No rows returned."

- [ ] **Step 2: Verify owner access is intact**

In each branch, confirm the owner login still loads leads/bookings normally (open the dashboard). This is the safety check on the RLS swap.

- [ ] **Step 3: Create a test technician + a test booking, run the RLS test**

```bash
ENV_FILE=whatsapp-service/.env.perth node execution/create_technician.mjs --email tech.test@perthview.app --password 'Test#2026' --name "Test Tech"
```
Assign one Perth booking to that tech (set `assigned_worker_id` to the returned uid — via the dashboard dropdown once Task 6 ships, or a one-off PATCH). Then:
```bash
ENV_FILE=whatsapp-service/.env.perth TECH_EMAIL=tech.test@perthview.app TECH_PASSWORD='Test#2026' node execution/test_technician_rls.mjs
```
Expected: prints the tech's booking count and `leads/revenue/clients/expenses: 0 ✓`, ending `PASS`.

- [ ] **Step 4: Deploy frontend (USER says "push it")**

```bash
git push origin main   # Vercel auto-deploys both NSW + Perth dashboards from main
```

- [ ] **Step 5: Provision real technicians + end-to-end check**

Run `create_technician.mjs` per real tech per branch. Log in as one → confirm they see only their assigned jobs, can mark done + note, and see no pricing/leads. Delete the test technician profile + auth user.

---

## Self-Review

**Spec coverage:**
- `profiles` + `assigned_worker_id` + `tech_notes` → Task 1. ✅
- `is_owner()` + role-aware RLS + column-guard trigger + owner seed + sequencing → Task 1 DDL. ✅
- Owner-only leads/revenue/clients/expenses; tech bookings-only → Task 1 policies, proven in Task 3/7. ✅
- Role routing (owner dashboard vs TechnicianView) → Task 4. ✅
- TechnicianView (view + mark done + note, no pricing, address, tap-to-call) → Task 5. ✅
- Owner assignment dropdown writing `assigned_worker_id` → Task 6. ✅
- Provisioning script, both branches, security test → Tasks 2, 3, 7. ✅
- Backend `service_role` unchanged (only `BOOKING_COLS` map added) → Task 1 Step 2. ✅

**Placeholder scan:** No TBD/TODO. Frontend tasks include real code; where a task says "match the actual export names / read the file first" that's an integration instruction against existing code, not a deferred decision. ✅

**Type consistency:** `fetchCurrentProfile()`/`fetchTechnicians()` return `{id,role,display_name,active}` / `{id,display_name}` used consistently in Tasks 4 & 6. `useTechnicianBookings()` shape matches its consumer in Task 5. Booking field keys (`'Assigned Worker Id'`, `'Tech Notes'`, `'Booking Status'`) match `BOOKING_COLS` (Task 1) across the hook, dropdown, and DDL columns. Role/status string values match the Global Constraints. ✅
