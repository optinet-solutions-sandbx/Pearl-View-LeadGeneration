/* Standalone tests for the booking-form invite rules, plus parity of the time
   parsing with the backend (whatsapp-service/calendar-core.js parseJobTime).
   Run: node execution/test_invite_rules.mjs   (exit 0 = pass) */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { timeRequired, inviteStatusLabel, TIME_REQUIRED_MSG, isParseableTime } from '../src/utils/inviteRules.js';

const require = createRequire(import.meta.url);
const be = require('../whatsapp-service/calendar-core.js');

const MSG = 'Add a time — the client gets a calendar invitation.';
assert.equal(TIME_REQUIRED_MSG, MSG);

// timeRequired
assert.equal(timeRequired('jane@x.com', ''), MSG);
assert.equal(timeRequired('jane@x.com', '   '), MSG);
assert.equal(timeRequired('jane@x.com', null), MSG);
assert.equal(timeRequired('jane@x.com', 'morning'), MSG);
assert.equal(timeRequired('jane@x.com', '25:00'), MSG);
assert.equal(timeRequired('jane@x.com', '9:00 AM'), '');
assert.equal(timeRequired('Jane <jane@x.com>', ''), MSG);
assert.equal(timeRequired('', ''), '');
assert.equal(timeRequired(null, ''), '');
assert.equal(timeRequired('not-an-email', ''), '');
assert.equal(timeRequired('   ', ''), '');

// parity with backend parseJobTime
for (const t of ['9:00 AM', '9:00am', '9:00 pm', '12:00 AM', '12:30 PM', '13:00', '00:00', '23:59', '24:00',
  '0:30 AM', '13:00 PM', '9:60', '9', '', '  ', null, undefined, 'abc', '9:00  AM', '9:00 Am', '1:5 PM', '09:05']) {
  assert.equal(isParseableTime(t), be.parseJobTime(t) !== null, `parity ${JSON.stringify(t)}`);
  assert.equal(timeRequired('a@b.co', t) === '', be.parseJobTime(t) !== null, `timeRequired parity ${JSON.stringify(t)}`);
}

// inviteStatusLabel
const S = { enabled: true };
const lab = st => inviteStatusLabel({ inviteStatus: st }, S);
assert.equal(lab('sent').text, '📅 Invite sent');
assert.equal(lab('pending').text, 'Invite queued');
assert.equal(lab('sending').text, 'Invite queued');
assert.equal(lab('no_email').text, 'No email');
assert.equal(lab('needs_time').text, 'Needs a time');
assert.equal(lab('failed').text, 'Invite failed — check the email');
assert.equal(lab('emailed_ics').text, 'Invite emailed');
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

console.log('test_invite_rules: all passed');
