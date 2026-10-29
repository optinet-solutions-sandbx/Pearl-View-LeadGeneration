/* Standalone tests for the booking-form invite rules.
   Run: node execution/test_invite_rules.mjs   (exit 0 = pass) */
import assert from 'node:assert/strict';
import * as rules from '../src/utils/inviteRules.js';
import { timeHint, inviteStatusLabel, changedFields } from '../src/utils/inviteRules.js';

// The time is optional: no rule blocks a save on a missing time any more.
assert.equal(rules.timeRequired, undefined);

// timeHint — what the Job Time field says about the invitation
const ON = { enabled: true };
const ALL_DAY_HINT = "Without a time, the client's invitation is for the whole day";
const NO_EMAIL_HINT = 'No email on file — no calendar invitation will be sent';
assert.equal(timeHint('jane@x.com', ON), ALL_DAY_HINT);
assert.equal(timeHint('Jane <jane@x.com>', ON), ALL_DAY_HINT);
for (const e of ['', null, undefined, '   ', 'not-an-email']) {
  assert.equal(timeHint(e, ON), NO_EMAIL_HINT, `no email ${JSON.stringify(e)}`);
}
// invitations off / not set up on this branch → no invitation talk
assert.equal(timeHint('jane@x.com', { enabled: false }), '');
assert.equal(timeHint('jane@x.com', null), '');
assert.equal(timeHint('jane@x.com'), '');

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
