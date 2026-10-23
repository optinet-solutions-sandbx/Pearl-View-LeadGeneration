/* Standalone tests for the booking-form invite rules, plus parity of the time
   parsing with the backend (whatsapp-service/calendar-core.js parseJobTime).
   Run: node execution/test_invite_rules.mjs   (exit 0 = pass) */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { timeRequired, inviteStatusLabel, TIME_REQUIRED_MSG, isParseableTime, changedFields } from '../src/utils/inviteRules.js';

const require = createRequire(import.meta.url);
const be = require('../whatsapp-service/calendar-core.js');

const MSG = 'Add a time — the client gets a calendar invitation.';
assert.equal(TIME_REQUIRED_MSG, MSG);

// timeRequired (invites switched on)
const ON = { enabled: true };
assert.equal(timeRequired('jane@x.com', '', ON), MSG);
assert.equal(timeRequired('jane@x.com', '   ', ON), MSG);
assert.equal(timeRequired('jane@x.com', null, ON), MSG);
assert.equal(timeRequired('jane@x.com', 'morning', ON), MSG);
assert.equal(timeRequired('jane@x.com', '25:00', ON), MSG);
assert.equal(timeRequired('jane@x.com', '9:00 AM', ON), '');
assert.equal(timeRequired('Jane <jane@x.com>', '', ON), MSG);
assert.equal(timeRequired('', '', ON), '');
assert.equal(timeRequired(null, '', ON), '');
assert.equal(timeRequired('not-an-email', '', ON), '');
assert.equal(timeRequired('   ', '', ON), '');
// nothing will be sent → no time rule
assert.equal(timeRequired('jane@x.com', '', { enabled: false }), '');
assert.equal(timeRequired('jane@x.com', '', null), '');
assert.equal(timeRequired('jane@x.com', ''), '');

// parity with backend parseJobTime
for (const t of ['9:00 AM', '9:00am', '9:00 pm', '12:00 AM', '12:30 PM', '13:00', '00:00', '23:59', '24:00',
  '0:30 AM', '13:00 PM', '9:60', '9', '', '  ', null, undefined, 'abc', '9:00  AM', '9:00 Am', '1:5 PM', '09:05']) {
  assert.equal(isParseableTime(t), be.parseJobTime(t) !== null, `parity ${JSON.stringify(t)}`);
  assert.equal(timeRequired('a@b.co', t, ON) === '', be.parseJobTime(t) !== null, `timeRequired parity ${JSON.stringify(t)}`);
}

// inviteStatusLabel
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const now = new Date();
const TODAY = ymd(now);
const YESTERDAY = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
const TOMORROW = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
const S = { enabled: true };
const lab = (st, o = {}) => inviteStatusLabel({ inviteStatus: st, bookingStatus: 'Scheduled', date: TOMORROW, ...o }, S);
assert.equal(lab('sent').text, '📅 Invite sent');
assert.equal(lab('pending').text, 'Invite queued');
assert.equal(lab('sending').text, 'Invite queued');
assert.equal(lab('no_email').text, 'No email');
assert.equal(lab('needs_time').text, 'Needs a time');
assert.equal(lab('failed').text, 'Invite failed');
assert.equal(lab('emailed_ics').text, "Invite emailed (can't be moved automatically)");
for (const st of ['sent', 'pending', 'sending', 'no_email', 'needs_time', 'failed', 'emailed_ics']) {
  assert.ok(['ok', 'warn', 'bad', 'muted'].includes(lab(st).tone), `tone ${st}`);
}
assert.equal(lab('failed').tone, 'bad');
assert.equal(lab('sent').tone, 'ok');
assert.equal(lab('cancelled'), null);
assert.equal(lab('legacy'), null);
assert.equal(lab(''), null);
assert.equal(lab(null), null);
assert.equal(lab('weird'), null);
assert.equal(inviteStatusLabel({ inviteStatus: 'sent' }, null), null);
assert.equal(inviteStatusLabel(null, S), null);
// "will be sent" labels only for a Scheduled booking dated today or later
for (const st of ['pending', 'sending', 'needs_time', 'no_email']) {
  assert.ok(lab(st, { date: TODAY }), `${st} today`);
  assert.ok(lab(st, { date: `${TOMORROW}T00:00:00+00:00` }), `${st} timestamptz`);
  assert.equal(lab(st, { date: YESTERDAY }), null, `${st} past`);
  assert.equal(lab(st, { bookingStatus: 'Completed' }), null, `${st} completed`);
  assert.equal(lab(st, { bookingStatus: 'Cancelled' }), null, `${st} cancelled`);
}
// what already happened is always shown
for (const st of ['sent', 'failed', 'emailed_ics']) {
  assert.ok(lab(st, { date: YESTERDAY, bookingStatus: 'Completed' }), `${st} past+completed`);
}

// changedFields — the Edit save sends only what changed (trimmed; '' == null/undefined)
const init = { clientName: 'Jane', phone: '', email: 'j@x.com', date: '2026-11-06', city: '', address: '',
  service: 'Window Cleaning', jobTime: '9:00 AM', assignedWorker: '', assignedWorkerId: '' };
assert.deepEqual(changedFields({ ...init }, init), {}, 'untouched → nothing');
assert.deepEqual(changedFields({ ...init, city: '  ' }, { ...init, city: null }), {}, "'' equals null");
assert.deepEqual(changedFields({ ...init, address: '' }, { ...init, address: undefined }), {}, "'' equals undefined");
assert.deepEqual(changedFields({ ...init, clientName: ' Jane ' }, init), {}, 'whitespace-only edit → nothing');
assert.deepEqual(changedFields({ ...init, city: ' Byron ' }, init), { city: 'Byron' }, 'changed → trimmed value');
assert.deepEqual(changedFields({ ...init, email: '' }, init), { email: '' }, 'clearing is a change');
assert.deepEqual(changedFields({ ...init, assignedWorkerId: '' }, { ...init, assignedWorkerId: 'u1' }), { assignedWorkerId: '' }, 'unassign');
assert.deepEqual(changedFields({ ...init, date: '2026-11-13', jobTime: '10:00 AM' }, init),
  { date: '2026-11-13', jobTime: '10:00 AM' }, 'only the moved fields');

console.log('test_invite_rules: all passed');
