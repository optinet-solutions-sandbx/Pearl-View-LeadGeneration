/* Live check of the calendar-invite sync-flag trigger.
   Run AFTER execution/supabase_calendar_invites.sql:
     node --env-file=.env execution/test_calendar_trigger.mjs     (exit 0 = pass)
   Creates bookings named "TEST Calendar …", deletes them at the end, and restores
   calendar_invite_settings.enabled. While it runs (seconds) the feature is ON — any real
   booking created in that window is flagged but HELD by test mode. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.USE_SUPABASE = 'true';
const require = createRequire(import.meta.url);
require('../whatsapp-service/sb.js'); // same env/config bootstrap as the follow-up verifier

const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_ROLE;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
async function rest(method, path, body) {
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
const insertB = async f => (await rest('POST', 'bookings', {
  booking_name: 'TEST Calendar', client_name: 'TEST Calendar Client', city: 'Sydney',
  job_service: 'Window Cleaning', date: '2030-01-15T00:00:00Z', job_time: '09:00', booking_status: 'Scheduled', ...f,
}))[0];
const patchB = async (id, f) => (await rest('PATCH', `bookings?id=eq.${id}`, f))[0];
const setEnabled = enabled => rest('PATCH', 'calendar_invite_settings?id=eq.1', { enabled });

const [orig] = await rest('GET', 'calendar_invite_settings?id=eq.1&select=enabled,test_mode');
assert.ok(orig, 'calendar_invite_settings row missing — run execution/supabase_calendar_invites.sql first');
assert.equal(orig.test_mode, true, 'Refusing to run: calendar_invite_settings.test_mode must be ON');
const created = [];
const track = async f => { const b = await insertB(f); created.push(b.id); return b; };

try {
  await setEnabled(true);

  // 1. legacy rows are never flagged by edits
  let l = await track({ gcal_status: 'legacy' });
  assert.equal(l.gcal_sync_needed, false);
  assert.equal(l.gcal_rev, 0);
  l = await patchB(l.id, { job_time: '11:00', city: 'Newtown' });
  assert.equal(l.gcal_status, 'legacy');
  assert.equal(l.gcal_sync_needed, false);
  assert.equal(l.gcal_rev, 0);

  // 2. insert while enabled (no supplied status) → pending / flagged / rev 1
  let b = await track({});
  assert.equal(b.gcal_status, 'pending');
  assert.equal(b.gcal_sync_needed, true);
  assert.equal(b.gcal_rev, 1);

  // 3. gcal_*-only update never re-flags and never bumps rev (the job's own writes)
  b = await patchB(b.id, { gcal_sync_needed: false, gcal_fail_count: 4, gcal_next_at: '2030-01-01T00:00:00Z', gcal_synced_at: new Date().toISOString() });
  assert.equal(b.gcal_sync_needed, false);
  assert.equal(b.gcal_rev, 1);
  assert.equal(b.gcal_fail_count, 4);

  // 4. a non-relevant column (amount) does not flag
  b = await patchB(b.id, { amount: 123 });
  assert.equal(b.gcal_sync_needed, false);
  assert.equal(b.gcal_rev, 1);

  // 5. a relevant edit flags, bumps rev, resets fail count and next_at
  b = await patchB(b.id, { job_time: '10:30' });
  assert.equal(b.gcal_sync_needed, true);
  assert.equal(b.gcal_rev, 2);
  assert.equal(b.gcal_fail_count, 0);
  assert.equal(b.gcal_next_at, null);

  // 6. conditional finish (sync job): stale rev updates 0 rows, current rev updates 1
  const stale = await rest('PATCH', `bookings?id=eq.${b.id}&gcal_rev=eq.1`, { gcal_sync_needed: false });
  assert.equal(stale.length, 0, 'stale-rev conditional PATCH must update 0 rows');
  assert.equal((await rest('GET', `bookings?id=eq.${b.id}&select=gcal_sync_needed`))[0].gcal_sync_needed, true);
  const fresh = await rest('PATCH', `bookings?id=eq.${b.id}&gcal_rev=eq.2`, { gcal_sync_needed: false });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].gcal_rev, 2);

  // 7. a supplied status on INSERT ('sending', self-rebook) is left alone while enabled
  const s = await track({ gcal_status: 'sending' });
  assert.equal(s.gcal_status, 'sending');
  assert.equal(s.gcal_sync_needed, false);
  assert.equal(s.gcal_rev, 0);

  // 8. disabled + already has an event id → still flagged on edit (cancels/moves sync)
  await setEnabled(false);
  let e = await track({ gcal_status: 'sent', gcal_event_id: 'test-event-id' });
  assert.equal(e.gcal_sync_needed, false);
  e = await patchB(e.id, { booking_status: 'Cancelled' });
  assert.equal(e.gcal_sync_needed, true);
  assert.equal(e.gcal_rev, 1);

  // 9. disabled + no event id → not flagged (insert or edit)
  let n = await track({});
  assert.equal(n.gcal_status, null);
  assert.equal(n.gcal_sync_needed, false);
  n = await patchB(n.id, { city: 'Bondi', client_email: 'trigger-check@example.com' });
  assert.equal(n.gcal_sync_needed, false);
  assert.equal(n.gcal_rev, 0);

  console.log('PASS — calendar invite trigger behaves as designed');
} finally {
  try { await setEnabled(orig.enabled); }
  catch (e) { console.error('🚨 FEATURE LEFT ENABLED — set calendar_invite_settings.enabled back to', orig.enabled, 'manually:', e.message); process.exitCode = 1; }
  for (const id of created) await rest('DELETE', `bookings?id=eq.${id}`).catch(err => console.error('cleanup failed', id, err.message));
}
