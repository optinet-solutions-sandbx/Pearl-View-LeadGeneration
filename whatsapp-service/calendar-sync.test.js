// Orchestration tests for runCalendarSync() against fake deps (no DB / Google).
// Run: node --test calendar-sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runCalendarSync } = require('./calendar-sync');
const { eventIdFor } = require('./calendar-core');

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
  insert = async () => 'EV_NEW', patch = async () => {}, del = async () => {}, probe = async () => {},
  record = async () => {} } = {}) {
  const calls = { fetch: [], claim: [], finish: [], insert: [], patch: [], del: [], record: [], order: [], probe: 0 };
  return {
    calls,
    deps: {
      getSettings: async () => settings,
      fetchDue: async args => { calls.fetch.push(args); return rows; },
      claim: async (...a) => { calls.claim.push(a); return claim; },
      recordEvent: async (...a) => { calls.record.push(a); calls.order.push('record'); return record(...a); },
      finish: async (id, rev, p) => { calls.finish.push([id, rev, p]); calls.order.push('finish'); return finish; },
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

test('insert 409 adopts the existing event', async () => {
  const { deps, calls } = fakeDeps({ insert: async () => { throw gone(409); } });
  const r = await runCalendarSync({ now: NOW, deps });
  const id = eventIdFor('B1', 3);
  assert.equal(r.errors, 0);
  assert.equal(r.created, 1);
  assert.equal(calls.insert[0].id, id);
  assert.equal(calls.patch[0][0], id);
  assert.equal(calls.finish[0][2].gcal_event_id, id);
});

test('recreate uses the current rev id', async () => {
  const { deps, calls } = fakeDeps({
    rows: [BOOKING({ gcal_event_id: 'EV_OLD', gcal_attendee: 'jane@x.com', gcal_rev: 7 })],
    patch: async id => { if (id === 'EV_OLD') throw gone(404); },
    insert: async b => b.id,
  });
  await runCalendarSync({ now: NOW, deps });
  assert.equal(calls.insert[0].id, eventIdFor('B1', 7));
  assert.equal(calls.finish[0][2].gcal_event_id, eventIdFor('B1', 7));
});

test('two overlapping runs: the second claim fails, no second insert', async () => {
  let leased = false;
  const a = fakeDeps();
  const b = fakeDeps();
  const claim = async () => { if (leased) return false; leased = true; return true; };
  a.deps.claim = claim; b.deps.claim = claim;
  await Promise.all([runCalendarSync({ now: NOW, deps: a.deps }), runCalendarSync({ now: NOW, deps: b.deps })]);
  assert.equal(a.calls.insert.length + b.calls.insert.length, 1);
});

test('test mode asks fetchDue for testOnly; a held real row is not claimed', async () => {
  const { deps, calls } = fakeDeps({ settings: SETTINGS({ test_mode: true }) });
  await runCalendarSync({ now: NOW, deps });
  assert.equal(calls.fetch[0].testOnly, true);
  assert.equal(calls.claim.length, 0);
  const off = fakeDeps();
  await runCalendarSync({ now: NOW, deps: off.deps });
  assert.equal(off.calls.fetch[0].testOnly, false);
});

// ── The new event id is persisted (by booking id only) BEFORE the rev-guarded finish
test('records the new event id before finish', async () => {
  const { deps, calls } = fakeDeps();
  await runCalendarSync({ now: NOW, deps });
  assert.deepEqual(calls.record, [['B1', 'EV_NEW', 'jane@x.com']]);
  assert.deepEqual(calls.order, ['record', 'finish']);
});

test('records the id of an adopted (409) or recreated event; a plain update records nothing', async () => {
  const adopt = fakeDeps({ insert: async () => { throw gone(409); } });
  await runCalendarSync({ now: NOW, deps: adopt.deps });
  assert.deepEqual(adopt.calls.record, [['B1', eventIdFor('B1', 3), 'jane@x.com']]);

  const recreate = fakeDeps({
    rows: [BOOKING({ gcal_event_id: 'EV_OLD', gcal_attendee: 'jane@x.com' })],
    patch: async () => { throw gone(404); },
  });
  await runCalendarSync({ now: NOW, deps: recreate.deps });
  assert.deepEqual(recreate.calls.record, [['B1', 'EV_NEW', 'jane@x.com']]);

  const plain = fakeDeps({ rows: [BOOKING({ gcal_event_id: 'EV1', gcal_attendee: 'jane@x.com' })] });
  await runCalendarSync({ now: NOW, deps: plain.deps });
  assert.equal(plain.calls.record.length, 0);
});

test('a failed event-id write alerts, counts an error and skips finish', async () => {
  const { deps, calls } = fakeDeps({ record: async () => { throw new Error('db down'); } });
  const r = await runCalendarSync({ now: NOW, deps });
  assert.equal(r.errors, 1);
  assert.equal(r.created, 0);
  assert.equal(calls.insert.length, 1);
  assert.equal(calls.finish.length, 0); // lease expires; the deterministic id + 409-adopt covers the retry
  assert.ok(console.error.mock.calls.some(c => /\[ALERT\]/.test(String(c.arguments[0]))));
});

// Fake with per-booking state, so an office edit (rev bump) can land between the
// Google insert and finish — and the next run sees whatever was recorded.
function statefulDeps(row, google, onInsert) {
  const calls = { insert: [], patch: [], del: [] };
  return {
    calls,
    deps: {
      getSettings: async () => SETTINGS(),
      fetchDue: async () => (row.gcal_sync_needed ? [{ ...row }] : []),
      claim: async (id, rev) => rev === row.gcal_rev,
      recordEvent: async (id, eventId, attendee) => { Object.assign(row, { gcal_event_id: eventId, gcal_attendee: attendee }); },
      finish: async (id, rev, p) => { if (rev !== row.gcal_rev) return false; Object.assign(row, p); return true; },
      insertEvent: async b => { calls.insert.push(b); google[b.id] = { start: b.start.dateTime, status: 'confirmed' }; if (onInsert) onInsert(); return b.id; },
      patchEvent: async (id, b) => { calls.patch.push(id); google[id].start = b.start.dateTime; },
      deleteEvent: async id => { calls.del.push(id); google[id].status = 'cancelled'; },
    },
  };
}

async function editDuringFirstInsert() {
  const row = BOOKING({ booking_status: 'Scheduled', gcal_rev: 1 });
  const google = {};
  const officeEdit = () => { row.date = '2026-11-13T00:00:00+00:00'; row.gcal_rev++; row.gcal_sync_needed = true; };
  const run1 = await runCalendarSync({ now: NOW, deps: statefulDeps(row, google, officeEdit).deps });
  const second = statefulDeps(row, google);
  const run2 = await runCalendarSync({ now: NOW, deps: second.deps });
  return { row, google, run1, run2, second, first: eventIdFor('B1', 1) };
}

test('an edit between insert and finish → next run updates the stored event, never inserts again', async () => {
  const { row, google, run1, run2, second, first } = await editDuringFirstInsert();
  assert.equal(run1.requeued, 1);
  assert.equal(run2.updated, 1);
  assert.equal(second.calls.insert.length, 0);
  assert.deepEqual(second.calls.patch, [first]);
  assert.deepEqual(Object.keys(google), [first]);
  assert.equal(google[first].start, '2026-11-13T09:00:00');
  assert.equal(row.gcal_event_id, first);
  assert.equal(row.gcal_sync_needed, false);
});

test('an edit between insert and finish → then a cancel deletes the first event', async () => {
  const { row, google, first } = await editDuringFirstInsert();
  row.booking_status = 'Cancelled'; row.gcal_rev++; row.gcal_sync_needed = true;
  const third = statefulDeps(row, google);
  const run3 = await runCalendarSync({ now: NOW, deps: third.deps });
  assert.equal(run3.cancelled, 1);
  assert.deepEqual(third.calls.del, [first]);
  assert.ok(Object.values(google).every(e => e.status === 'cancelled'), JSON.stringify(google));
  assert.equal(row.gcal_event_id, null);
});
