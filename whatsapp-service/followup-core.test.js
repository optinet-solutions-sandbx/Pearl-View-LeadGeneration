// Unit tests for the pure follow-up logic. Run: node --test followup-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

test('replySearchQuery bounds the search by the quote date when it is valid', () => {
  assert.equal(core.replySearchQuery('jane@x.com', '2026-10-09T00:00:00Z'),
    'from:jane@x.com after:1791504000 -in:sent -in:chats');
});

test('replySearchQuery falls back to a 30-day window when the date is null or invalid', () => {
  assert.equal(core.replySearchQuery('jane@x.com', null), 'from:jane@x.com newer_than:30d -in:sent -in:chats');
  assert.equal(core.replySearchQuery('jane@x.com', 'garbage'), 'from:jane@x.com newer_than:30d -in:sent -in:chats');
});
const core = require('./followup-core');

test('cleanEmail extracts a bare address from messy input', () => {
  assert.equal(core.cleanEmail('  jane@x.com  '), 'jane@x.com');
  assert.equal(core.cleanEmail('Jane Doe <jane@x.com>'), 'jane@x.com');
  assert.equal(core.cleanEmail('jane​@x.com'), 'jane@x.com');
  assert.equal(core.cleanEmail('jane@x.com\r\nBcc: evil@y.com'), 'jane@x.com');
  assert.equal(core.cleanEmail(''), '');
  assert.equal(core.cleanEmail(null), '');
  assert.equal(core.cleanEmail('not an email'), '');
});

test('firstName falls back to "there" for placeholder names', () => {
  assert.equal(core.firstName('Jane Smith'), 'Jane');
  assert.equal(core.firstName('  jane  '), 'jane');
  for (const n of ['', null, 'Unknown', 'Unknown Caller', 'unknown caller', '—', '-']) {
    assert.equal(core.firstName(n), 'there', String(n));
  }
});

test('formatMoney', () => {
  assert.equal(core.formatMoney(350), '$350');
  assert.equal(core.formatMoney(1234.5), '$1,234.50');
  assert.equal(core.formatMoney('980'), '$980');
  assert.equal(core.formatMoney(0), '');
  assert.equal(core.formatMoney(null), '');
});

test('renderTemplate fills known placeholders and leaves unknown ones', () => {
  const ctx = { first_name: 'Jane', company: 'Pearlview', sender: 'Brad', quote_amount: '$350', client_name: 'Jane Smith' };
  assert.equal(
    core.renderTemplate('Hi {first_name}, {company} quoted {quote_amount}. {sender} {oops}', ctx),
    'Hi Jane, Pearlview quoted $350. Brad {oops}',
  );
  assert.equal(core.renderTemplate(null, ctx), '');
});

test('buildContext: settings company/signature win, fallbacks fill blanks', () => {
  const lead = { client_name: 'Jane Smith', quote_amount: 350 };
  assert.deepEqual(
    core.buildContext(lead, { sender_name: 'Brad @ Pearlview', company_name: 'Pearlview Window Cleaning' }, 'Fallback Co'),
    { first_name: 'Jane', client_name: 'Jane Smith', company: 'Pearlview Window Cleaning', sender: 'Brad @ Pearlview', quote_amount: '$350' },
  );
  const blank = core.buildContext(lead, { sender_name: ' ', company_name: '' }, 'Fallback Co');
  assert.equal(blank.company, 'Fallback Co');
  assert.equal(blank.sender, 'Fallback Co');
});

test('htmlFromText escapes HTML and keeps paragraphs', () => {
  const html = core.htmlFromText('Hi <b>Jane</b> & "co",\n\nLine one\nLine two');
  assert.match(html, /Hi &lt;b&gt;Jane&lt;\/b&gt; &amp; &quot;co&quot;,/);
  assert.match(html, /Line one<br>Line two/);
  assert.equal((html.match(/<p /g) || []).length, 2);
  assert.doesNotMatch(html, /<b>/);
});

test('b64url is URL-safe and unpadded', () => {
  assert.equal(core.b64url('>>>???'), 'Pj4-Pz8_');
  assert.doesNotMatch(core.b64url('any string at all!'), /[+/=]/);
});

test('buildFollowupMime tags the email and blocks header injection', () => {
  const mime = core.buildFollowupMime({
    fromName: 'Pearlview Window Cleaning', fromEmail: 'service@pearlview.com.au',
    to: 'jane@x.com\r\nBcc: evil@y.com', subject: 'Hi\r\nBcc: evil@y.com', text: 'Hello', html: '<p>Hello</p>',
  });
  assert.match(mime, /^X-PearlView-Kind: followup$/m);
  assert.match(mime, /^To: jane@x\.com$/m);
  assert.match(mime, /^Reply-To: Pearlview Window Cleaning <service@pearlview\.com\.au>$/m);
  assert.doesNotMatch(mime, /^Bcc:/im);
  assert.match(mime, /Content-Type: multipart\/alternative/);
});

test('buildFollowupMime encodes non-ASCII subjects', () => {
  const mime = core.buildFollowupMime({ fromName: 'P', fromEmail: 'a@b.co', to: 'c@d.co', subject: 'Quote — check-in', text: 't', html: 'h' });
  assert.match(mime, /^Subject: =\?UTF-8\?B\?.+\?=$/m);
});

test('isFollowupMessage detects our header (case-insensitive)', () => {
  assert.equal(core.isFollowupMessage([{ name: 'x-pearlview-kind', value: 'FollowUp ' }]), true);
  assert.equal(core.isFollowupMessage([{ name: 'Subject', value: 'followup' }]), false);
  assert.equal(core.isFollowupMessage(undefined), false);
});

test('replyAlertText names the customer, inbox and dashboard', () => {
  const t = core.replyAlertText({ client_name: 'Jane Smith', email: 'jane@x.com' }, 'service@pearlview.com.au', 'https://dash');
  assert.match(t, /Jane Smith \(jane@x\.com\)/);
  assert.match(t, /service@pearlview\.com\.au/);
  assert.match(t, /https:\/\/dash/);
  assert.match(core.replyAlertText({ client_name: '', email: '' }, 'i', 'u'), /A customer \(no email\)/);
});

// ─── Scheduling decisions ────────────────────────────────────────────────────
const SETTINGS = () => ({
  enabled: true, test_mode: false, test_email: 'owner@test.com', sender_name: 'Pearlview',
  window_start_hour: 8, window_end_hour: 18,
  steps: [
    { enabled: true, delay_hours: 48, subject: 'S1 {first_name}', body: 'B1 {first_name} {quote_amount}' },
    { enabled: true, delay_hours: 72, subject: 'S2', body: 'B2' },
    { enabled: true, delay_hours: 120, subject: 'S3 {company}', body: 'B3' },
  ],
});
const LEAD = (o = {}) => ({ id: 'L1', client_name: 'Jane Smith', email: 'jane@x.com', quote_amount: 350, followup_step: 0, followup_fail_count: 0, ...o });
const NOW = new Date('2026-10-12T00:00:00Z'); // 11:00 Sydney (AEDT, UTC+11)

test('inSendWindow uses business-local hours incl. DST', () => {
  assert.equal(core.inSendWindow(new Date('2026-10-12T00:00:00Z'), 'Australia/Sydney', 8, 18), true);   // 11:00 AEDT
  assert.equal(core.inSendWindow(new Date('2026-10-11T20:59:00Z'), 'Australia/Sydney', 8, 18), false);  // 07:59 AEDT
  assert.equal(core.inSendWindow(new Date('2026-10-12T07:00:00Z'), 'Australia/Sydney', 8, 18), false);  // 18:00 — end exclusive
  assert.equal(core.inSendWindow(new Date('2026-06-30T22:30:00Z'), 'Australia/Sydney', 8, 18), true);   // 08:30 AEST (winter)
  assert.equal(core.inSendWindow(new Date('2026-10-12T00:30:00Z'), 'Australia/Perth', 8, 18), true);    // 08:30 AWST
  assert.equal(core.inSendWindow(new Date('2026-10-12T00:00:00Z'), 'Australia/Sydney', null, undefined), true); // defaults 8–18
});

test('isTestLead matches a leading TEST word only', () => {
  assert.equal(core.isTestLead('TEST Full Run'), true);
  assert.equal(core.isTestLead('test-reply'), true);
  assert.equal(core.isTestLead('  Test Booked'), true);
  assert.equal(core.isTestLead('Testa Smith'), false);
  assert.equal(core.isTestLead('Jane TEST'), false);
  assert.equal(core.isTestLead(null), false);
});

test('delayHours falls back to defaults for missing/invalid values', () => {
  const steps = [{ delay_hours: 24 }, { delay_hours: 'abc' }, { delay_hours: null }];
  assert.equal(core.delayHours(steps, 0), 24);
  assert.equal(core.delayHours(steps, 1), 72);
  assert.equal(core.delayHours(steps, 2), 120);
  assert.equal(core.delayHours([{ delay_hours: -5 }], 0), 48);
  assert.equal(core.delayHours([{ delay_hours: '6' }], 0), 6);
});

test('planAction: live mode sends the current step to the customer', () => {
  assert.deepEqual(core.planAction(LEAD(), SETTINGS(), 'Pearlview Window Cleaning'), {
    type: 'send', stepIndex: 0, to: 'jane@x.com', realTo: 'jane@x.com', test: false, subject: 'S1 Jane', text: 'B1 Jane $350',
  });
  assert.equal(core.planAction(LEAD({ followup_step: 2 }), SETTINGS(), 'Pearlview').subject, 'S3 Pearlview');
});

test('planAction: test mode redirects TEST leads and holds real ones', () => {
  const s = { ...SETTINGS(), test_mode: true };
  const t = core.planAction(LEAD({ client_name: 'TEST Full Run' }), s, 'P');
  assert.equal(t.type, 'send');
  assert.equal(t.to, 'owner@test.com');
  assert.equal(t.test, true);
  assert.equal(t.subject, '[TEST → jane@x.com] S1 TEST');
  assert.deepEqual(core.planAction(LEAD(), s, 'P'), { type: 'hold', reason: 'test_mode' });
});

test('planAction: test mode with no valid test email holds even TEST leads', () => {
  for (const test_email of ['', null, 'nope']) {
    const s = { ...SETTINGS(), test_mode: true, test_email };
    assert.deepEqual(core.planAction(LEAD({ client_name: 'TEST x' }), s, 'P'), { type: 'hold', reason: 'no_test_email' });
  }
});

test('planAction: disabled or empty steps are skipped, finished sequences complete', () => {
  const s = SETTINGS();
  s.steps[1].enabled = false;
  s.steps[2].subject = '  ';
  assert.deepEqual(core.planAction(LEAD({ followup_step: 1 }), s, 'P'), { type: 'skip', stepIndex: 1 });
  assert.deepEqual(core.planAction(LEAD({ followup_step: 2 }), s, 'P'), { type: 'skip', stepIndex: 2 });
  assert.deepEqual(core.planAction(LEAD({ followup_step: 3 }), s, 'P'), { type: 'complete' });
  assert.deepEqual(core.planAction(LEAD(), { ...s, steps: null }, 'P'), { type: 'complete' });
});

test('planAction: lead without a usable email → no_email', () => {
  assert.deepEqual(core.planAction(LEAD({ email: '  ' }), SETTINGS(), 'P'), { type: 'no_email' });
});

test('afterStep schedules the next step from now', () => {
  assert.deepEqual(core.afterStep(SETTINGS(), 0, NOW, { sent: true }), {
    followup_step: 1, followup_next_at: '2026-10-15T00:00:00.000Z', followup_fail_count: 0,
  });
});

test('afterStep after the final SENT step closes the lead as Refused', () => {
  assert.deepEqual(core.afterStep(SETTINGS(), 2, NOW, { sent: true }), {
    followup_step: 3, followup_status: 'completed', followup_next_at: null, followup_fail_count: 0,
    lead_status: 'Refused', refusal_reason: 'no_response',
  });
});

test('afterStep after a SKIPPED final step completes without touching the status', () => {
  assert.deepEqual(core.afterStep(SETTINGS(), 2, NOW, { sent: false }), {
    followup_step: 3, followup_status: 'completed', followup_next_at: null, followup_fail_count: 0,
  });
});

test('afterFailure retries in 1h and gives up on the 3rd failure', () => {
  assert.deepEqual(core.afterFailure(LEAD({ followup_fail_count: 0 }), NOW), {
    followup_fail_count: 1, followup_next_at: '2026-10-12T01:00:00.000Z',
  });
  assert.deepEqual(core.afterFailure(LEAD({ followup_fail_count: 2 }), NOW), {
    followup_fail_count: 3, followup_status: 'error', followup_stop_reason: 'send_failed', followup_next_at: null,
  });
});

test('delayHours falls back to the default above the 8760h clamp', () => {
  assert.equal(core.delayHours([{ delay_hours: 9000 }], 0), 48);
});
