const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EVENT_MINUTES, BACKOFF_MINUTES, MAX_FAILS,
  parseJobTime, planSync, buildEvent, eventIdFor, afterSuccess, afterSkip, afterFailure,
} = require('./calendar-core');

test('constants', () => {
  assert.equal(EVENT_MINUTES, 120);
  assert.deepEqual(BACKOFF_MINUTES, [15, 60, 240]);
  assert.equal(MAX_FAILS, 5);
});

test('parseJobTime', () => {
  const ok = { '9:00 AM': '09:00', '12:30 PM': '12:30', '12:00 AM': '00:00', '2:30pm': '14:30', '14:30': '14:30', '9:00': '09:00' };
  for (const [i, o] of Object.entries(ok)) assert.equal(parseJobTime(i), o, i);
  for (const bad of ['', null, '  ', 'soon', '25:00', '9:75 AM']) assert.equal(parseJobTime(bad), null, String(bad));
});

const base = { client_name: 'Jane', client_email: 'jane@x.com', date: '2026-11-06', job_time: '9:00 AM', booking_status: 'Scheduled', gcal_event_id: null };
const today = '2026-10-23';
const on = { enabled: true, test_mode: false };
const plan = (o, s = on) => planSync({ ...base, ...o }, s, today);
const withEv = { gcal_event_id: 'e1', gcal_attendee: 'jane@x.com' };

test('planSync basics', () => {
  assert.deepEqual(plan({}), { type: 'create', attendee: 'jane@x.com' });
  assert.equal(plan(withEv).type, 'update');
  assert.equal(plan({ ...withEv, booking_status: 'Cancelled' }).type, 'cancel');
  assert.equal(plan({ booking_status: 'Cancelled' }).type, 'noop');
  assert.equal(plan({ booking_status: 'Completed' }).type, 'noop');
  assert.equal(plan({ date: '2026-10-22' }).type, 'past');
  assert.equal(plan({ date: '2026-10-22', ...withEv, booking_status: 'Cancelled' }).type, 'cancel');
  assert.equal(plan({ job_time: '' }).type, 'needs_time');
  assert.equal(plan({ client_email: '' }).type, 'no_email');
  assert.deepEqual(plan({ client_email: 'Jane <jane@x.com>' }), { type: 'create', attendee: 'jane@x.com' });
  assert.equal(plan({ client_email: '', gcal_event_id: 'e1' }).type, 'cancel');
});

test('planSync disabled', () => {
  const off = { enabled: false, test_mode: false };
  assert.equal(plan({}, off).type, 'noop');
  assert.equal(plan(withEv, off).type, 'update');
  assert.equal(plan({ ...withEv, booking_status: 'Cancelled' }, off).type, 'cancel');
});

test('planSync test mode', () => {
  const tm = { enabled: true, test_mode: true, test_email: 'owner@x.com' };
  assert.equal(plan({}, tm).type, 'hold');
  assert.deepEqual(plan({ client_name: 'TEST Jane' }, tm), { type: 'create', attendee: 'owner@x.com' });
  assert.equal(plan({ client_name: 'TEST Jane' }, { ...tm, test_email: '' }).type, 'hold');
  assert.equal(plan({ client_name: 'TEST Jane' }, { ...tm, test_email: 'nope' }).type, 'hold');
  assert.equal(plan(withEv, tm).type, 'update');
});

test('buildEvent', () => {
  const opts = { tz: 'Australia/Sydney', brandShort: 'Pearl View', businessEmail: 'b@pv.com', businessPhone: '0400', attendee: 'jane@x.com' };
  const e = buildEvent({ ...base, city: 'Sydney', service_address: '' }, opts);
  assert.equal(e.summary, 'Window Cleaning — Pearl View');
  assert.deepEqual(e.start, { dateTime: '2026-11-06T09:00:00', timeZone: 'Australia/Sydney' });
  assert.deepEqual(e.end, { dateTime: '2026-11-06T11:00:00', timeZone: 'Australia/Sydney' });
  assert.equal(e.location, 'Sydney');
  assert.equal(e.description, 'Your window clean with Pearl View.\nService: Window Cleaning\nNeed to change it? Reply to this invitation or contact us on 0400 / b@pv.com.');
  assert.deepEqual(e.attendees, [{ email: 'jane@x.com', displayName: 'Jane' }]);
  assert.deepEqual(e.reminders, { useDefault: true });
  const s = buildEvent({ ...base, job_service: 'Solar', service_address: '1 A St', city: 'X' }, opts);
  assert.equal(s.summary, 'Solar — Pearl View');
  assert.equal(s.location, '1 A St');
  assert.equal(buildEvent({ ...base }, opts).location, '');
  const late = buildEvent({ ...base, job_time: '11:00 PM' }, opts);
  assert.equal(late.start.dateTime, '2026-11-06T23:00:00');
  assert.equal(late.end.dateTime, '2026-11-07T01:00:00');
});

test('buildEvent marks the event confirmed (a patch revives a hand-deleted event)', () => {
  const opts = { tz: 'Australia/Sydney', brandShort: 'Pearl View', businessEmail: 'b@pv.com', businessPhone: '0400', attendee: 'jane@x.com' };
  assert.equal(buildEvent({ ...base }, opts).status, 'confirmed');
});

test('planSync: an existing event follows a move to a past date', () => {
  assert.deepEqual(plan({ ...withEv, date: '2026-10-22' }), { type: 'update', attendee: 'jane@x.com' });
  assert.equal(plan({ ...withEv, date: '2026-10-22T00:00:00+00:00' }).type, 'update');
  assert.equal(plan({ ...withEv, date: '2026-10-22' }, { enabled: false, test_mode: false }).type, 'update');
  assert.equal(plan({ date: '2026-10-22' }).type, 'past'); // no event yet → still never invites into the past
});

test('planSync: a blank time with an existing event leaves the event alone', () => {
  assert.equal(plan({ ...withEv, job_time: '' }).type, 'noop');
  assert.equal(plan({ ...withEv, job_time: '', date: '2026-10-22' }).type, 'noop');
  assert.equal(plan({ job_time: '' }).type, 'needs_time'); // no event yet → unchanged
});

test('timestamptz booking dates', () => {
  assert.equal(plan({ date: '2026-11-06T00:00:00+00:00' }).type, 'create');
  assert.equal(plan({ date: '2026-10-22T00:00:00+00:00' }).type, 'past');
  assert.equal(plan({ date: '2026-10-23T00:00:00+00:00' }).type, 'create');
  const opts = { tz: 'Australia/Sydney', brandShort: 'Pearl View', businessEmail: 'b@pv.com', businessPhone: '0400', attendee: 'jane@x.com' };
  const e = buildEvent({ ...base, date: '2026-11-06T00:00:00+00:00' }, opts);
  assert.equal(e.start.dateTime, '2026-11-06T09:00:00');
  assert.equal(e.end.dateTime, '2026-11-06T11:00:00');
});

const now = new Date('2026-10-23T00:00:00Z');
test('afterSuccess / afterSkip', () => {
  assert.deepEqual(afterSuccess('create', now, 'e9', 'jane@x.com'), {
    gcal_event_id: 'e9', gcal_status: 'sent', gcal_attendee: 'jane@x.com', gcal_sync_needed: false,
    gcal_fail_count: 0, gcal_next_at: null, gcal_synced_at: now.toISOString(),
  });
  assert.deepEqual(afterSuccess('cancel', now, 'e9', 'jane@x.com'), {
    gcal_event_id: null, gcal_status: 'cancelled', gcal_attendee: null, gcal_sync_needed: false,
    gcal_fail_count: 0, gcal_next_at: null, gcal_synced_at: now.toISOString(),
  });
  assert.equal(afterSuccess('update', now, 'e9', 'j@x.com').gcal_status, 'sent');
  assert.deepEqual(afterSkip('no_email'), { gcal_status: 'no_email', gcal_sync_needed: false, gcal_next_at: null });
  assert.deepEqual(afterSkip('needs_time'), { gcal_status: 'needs_time', gcal_sync_needed: false, gcal_next_at: null });
  assert.deepEqual(afterSkip('past'), { gcal_sync_needed: false, gcal_next_at: null });
  assert.deepEqual(afterSkip('noop'), { gcal_sync_needed: false, gcal_next_at: null });
});

test('afterFailure back-off', () => {
  const mins = [15, 60, 240, 240];
  mins.forEach((m, i) => {
    const p = afterFailure({ gcal_fail_count: i }, now);
    assert.equal(p.gcal_fail_count, i + 1);
    assert.equal(new Date(p.gcal_next_at).getTime() - now.getTime(), m * 60000);
  });
  const last = afterFailure({ gcal_fail_count: 4 }, now);
  assert.equal(last.gcal_status, 'failed');
  assert.equal(last.gcal_sync_needed, false);
  assert.equal(afterFailure({}, now).gcal_fail_count, 1);
});

test('eventIdFor: valid Google id, deterministic, differs per rev', () => {
  const id = eventIdFor('3F2A9C10-1B2C-4D5E-8F90-ABCDEF123456', 4);
  assert.equal(id, 'pv3f2a9c101b2c4d5e8f90abcdef123456r4');
  assert.match(id, /^[a-v0-9]{5,1024}$/);
  assert.equal(eventIdFor('3F2A9C10-1B2C-4D5E-8F90-ABCDEF123456', 4), id);
  assert.notEqual(eventIdFor('3F2A9C10-1B2C-4D5E-8F90-ABCDEF123456', 5), id);
});
