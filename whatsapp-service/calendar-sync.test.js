// Orchestration tests for runCalendarSync() against fake deps (no DB / Google).
// Run: node --test calendar-sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCalendarSync } = require('./calendar-sync');

test.beforeEach(() => {
  test.mock.method(console, 'log', () => {});
  test.mock.method(console, 'error', () => {});
});
test.afterEach(() => test.mock.restoreAll());

const NOW = new Date('2026-10-23T00:00:00Z'); // 11:00 Sydney, 2026-10-23
const SETTINGS = (o = {}) => ({ enabled: true, test_mode: false, test_email: 'owner@test.com', ...o });
const BOOKING = (o = {}) => ({
  id: 'B1', client_name: 'Jane Smith', client_email: 'jane@x.com', date: '2026-10-30T00:00:00+00:00',
  job_time: '9:00 AM', booking_status: 'Confirmed', job_service: 'Window Cleaning', service_address: '1 A St',
  city: 'Byron', gcal_event_id: null, gcal_status: null, gcal_attendee: null, gcal_sync_needed: true,
  gcal_rev: 3, gcal_fail_count: 0, ...o,
});
const gone = code => Object.assign(new Error('gone'), { code });

function fakeDeps({ settings = SETTINGS(), rows = [BOOKING()], claim = true, finish = true,
  insert = async () => 'EV_NEW', patch = async () => {}, del = async () => {}, probe = async () => {} } = {}) {
  const calls = { claim: [], finish: [], insert: [], patch: [], del: [], probe: 0 };
  return {
    calls,
    deps: {
      getSettings: async () => settings,
      fetchDue: async () => rows,
      claim: async (...a) => { calls.claim.push(a); return claim; },
      finish: async (id, rev, p) => { calls.finish.push([id, rev, p]); return finish; },
      insertEvent: async b => { calls.insert.push(b); return insert(b); },
      patchEvent: async (id, b) => { calls.patch.push([id, b]); return patch(id, b); },
      deleteEvent: async id => { calls.del.push(id); return del(id); },
      probe: async () => { calls.probe++; return probe(); },
    },
  };
}

test('creates and stores the event id', async () => {
  const { deps, calls } = fakeDeps();
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.created, 1);
  assert.equal(calls.insert.length, 1);
  assert.deepEqual(calls.claim[0].slice(0, 2), ['B1', 3]);
  const [id, rev, p] = calls.finish[0];
  assert.equal(id, 'B1'); assert.equal(rev, 3);
  assert.equal(p.gcal_event_id, 'EV_NEW'); assert.equal(p.gcal_status, 'sent'); assert.equal(p.gcal_sync_needed, false);
  assert.equal(p.gcal_attendee, 'jane@x.com');
});

test('updates an existing event', async () => {
  const { deps, calls } = fakeDeps({ rows: [BOOKING({ gcal_event_id: 'EV1', gcal_attendee: 'jane@x.com' })] });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.updated, 1);
  assert.equal(calls.patch[0][0], 'EV1');
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.finish[0][2].gcal_event_id, 'EV1');
});

test('cancels and clears the event id', async () => {
  const { deps, calls } = fakeDeps({ rows: [BOOKING({ booking_status: 'Cancelled', gcal_event_id: 'EV1' })] });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.cancelled, 1);
  assert.deepEqual(calls.del, ['EV1']);
  assert.equal(calls.finish[0][2].gcal_event_id, null);
  assert.equal(calls.finish[0][2].gcal_status, 'cancelled');
});

test('holds real bookings in test mode without claiming', async () => {
  const { deps, calls } = fakeDeps({ settings: SETTINGS({ test_mode: true }) });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.held, 1);
  assert.equal(calls.claim.length, 0);
  assert.equal(calls.finish.length, 0);
  assert.equal(calls.insert.length, 0);
});

test('a lost claim does nothing', async () => {
  const { deps, calls } = fakeDeps({ claim: false });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.created, 0);
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.finish.length, 0);
});

test('keeps the flag when the booking changed mid-sync', async () => {
  const { deps } = fakeDeps({ finish: false });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.errors, 0);
  assert.equal(r.requeued, 1);
});

test('404 on cancel is success', async () => {
  for (const code of [404, 410]) {
    const { deps, calls } = fakeDeps({
      rows: [BOOKING({ booking_status: 'Cancelled', gcal_event_id: 'EV1' })],
      del: async () => { throw gone(code); },
    });
    const r = await runCalendarSync({ now: NOW, deps });
    assert.equal(r.errors, 0);
    assert.equal(r.cancelled, 1);
    assert.equal(calls.finish[0][2].gcal_event_id, null);
  }
});

test('404 on update recreates', async () => {
  const { deps, calls } = fakeDeps({
    rows: [BOOKING({ gcal_event_id: 'EV_OLD', gcal_attendee: 'jane@x.com' })],
    patch: async () => { const e = new Error('nf'); e.response = { status: 404 }; throw e; },
  });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.errors, 0);
  assert.equal(r.updated, 1);
  assert.equal(calls.insert.length, 1);
  assert.equal(calls.finish[0][2].gcal_event_id, 'EV_NEW');
});

test('a Google failure backs off', async () => {
  const { deps, calls } = fakeDeps({ insert: async () => { throw gone(500); } });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.errors, 1);
  const p = calls.finish[0][2];
  assert.equal(p.gcal_fail_count, 1);
  assert.equal(p.gcal_next_at, new Date(NOW.getTime() + 15 * 60000).toISOString());
  assert.equal(p.gcal_sync_needed, undefined);
});

test('skips write the skip patch (no email, needs time)', async () => {
  const { deps, calls } = fakeDeps({ rows: [BOOKING({ client_email: '' }), BOOKING({ id: 'B2', job_time: '' })] });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.skipped, 2);
  assert.equal(calls.finish[0][2].gcal_status, 'no_email');
  assert.equal(calls.finish[1][2].gcal_status, 'needs_time');
  assert.equal(calls.insert.length, 0);
});

test('dry run claims and calls nothing', async () => {
  const { deps, calls } = fakeDeps();
  const r = await runCalendarSync({ dry: true, now: NOW, deps });
  assert.equal(r.dry, true);
  assert.equal(r.due, 1);
  assert.equal(r.actions[0].type, 'create');
  assert.equal(calls.claim.length + calls.finish.length + calls.insert.length + calls.patch.length + calls.del.length, 0);
});

test('disabled still processes rows with an event id', async () => {
  const { deps, calls } = fakeDeps({
    settings: SETTINGS({ enabled: false }),
    rows: [BOOKING({ gcal_event_id: 'EV1', gcal_attendee: 'jane@x.com' }), BOOKING({ id: 'B2' })],
  });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.updated, 1);
  assert.equal(r.created, 0);
  assert.equal(calls.insert.length, 0);
  assert.equal(calls.patch.length, 1);
});

test('probe reports ok', async () => {
  const { deps } = fakeDeps();
  assert.deepEqual(await runCalendarSync({ probe: true, deps }), { probe: 'ok' });
});

test('probe reports the error', async () => {
  const { deps } = fakeDeps({ probe: async () => { throw new Error('insufficient scope'); } });
  assert.deepEqual(await runCalendarSync({ probe: true, deps }), { probe: 'insufficient scope' });
});
