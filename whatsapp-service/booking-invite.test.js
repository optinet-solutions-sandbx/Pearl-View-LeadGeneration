const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInviteBody, buildGcalUrl } = require('./booking');
const { TZ } = require('./config');

test('buildInviteBody maps rebook args through buildEvent (business tz, 120 min)', () => {
  const b = buildInviteBody({ clientName: 'Jane', email: 'j@x.com', svc: 'Window Cleaning', date: '2026-11-06', timeStr: '09:00', address: '1 A St', city: 'Sydney' });
  assert.equal(b.start.dateTime, '2026-11-06T09:00:00');
  assert.equal(b.end.dateTime, '2026-11-06T11:00:00');
  assert.equal(b.start.timeZone, TZ);
  assert.equal(b.location, '1 A St');
  assert.deepEqual(b.attendees, [{ email: 'j@x.com', displayName: 'Jane' }]);
});

test('buildInviteBody falls back to 09:00 for an unparseable time', () => {
  const b = buildInviteBody({ clientName: 'J', email: 'j@x.com', svc: 'X', date: '2026-11-06', timeStr: 'soon' });
  assert.equal(b.start.dateTime, '2026-11-06T09:00:00');
});

const { sendInvite } = require('./booking');
const args = { bookingId: 'b1', clientName: 'J', email: 'j@x.com', svc: 'X', date: '2026-11-06', timeStr: '09:00' };
const mkDeps = (over) => { const calls = []; return { calls, deps: { updateBookingInvite: async (id, f) => { calls.push(f['Invite Status']); }, buildRebookEmail: () => ({}), ...over } }; };

test('sendInvite: both paths fail -> marks failed and rethrows the original error', async () => {
  const boom = new Error('mail down');
  const { calls, deps } = mkDeps({ createCalendarInvite: async () => { throw new Error('cal'); }, sendCalendarInvite: async () => { throw boom; } });
  await assert.rejects(() => sendInvite(args, deps), e => e === boom);
  assert.deepEqual(calls, ['failed']);
});

test('sendInvite: calendar ok -> sent; calendar fails + ics ok -> emailed_ics', async () => {
  let r = mkDeps({ createCalendarInvite: async () => ({ id: 'e' }) });
  assert.equal(await sendInvite(args, r.deps), 'calendar');
  assert.deepEqual(r.calls, ['sent']);
  r = mkDeps({ createCalendarInvite: async () => { throw new Error('x'); }, sendCalendarInvite: async () => ({}) });
  assert.equal(await sendInvite(args, r.deps), 'ics');
  assert.deepEqual(r.calls, ['emailed_ics']);
});

test('buildGcalUrl uses the business time zone', () => {
  assert.ok(buildGcalUrl({ svc: 'Window Cleaning', date: '2026-11-06', timeStr: '09:00' }).includes(encodeURIComponent(TZ)));
});
