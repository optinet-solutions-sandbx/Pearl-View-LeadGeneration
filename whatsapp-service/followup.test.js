// Orchestration tests for runFollowups() against fake deps (no DB / Gmail).
// Run: node --test followup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runFollowups } = require('./followup');

// The engine logs deliberately on failure paths; keep the test output clean.
test.beforeEach(() => {
  test.mock.method(console, 'log', () => {});
  test.mock.method(console, 'error', () => {});
});
test.afterEach(() => test.mock.restoreAll());

const NOW = new Date('2026-10-12T00:00:00Z'); // 11:00 Sydney — inside 8–18
const LATE = new Date('2026-10-12T10:00:00Z'); // 21:00 Sydney — outside
const SETTINGS = (o = {}) => ({
  enabled: true, test_mode: false, test_email: 'owner@test.com', sender_name: 'Pearlview',
  window_start_hour: 8, window_end_hour: 18,
  steps: [
    { enabled: true, delay_hours: 48, subject: 'S1', body: 'Hi {first_name}' },
    { enabled: true, delay_hours: 72, subject: 'S2', body: 'B2' },
    { enabled: true, delay_hours: 120, subject: 'S3', body: 'B3' },
  ],
  ...o,
});
const LEAD = (o = {}) => ({
  id: 'L1', client_name: 'Jane Smith', email: 'jane@x.com', quote_amount: 350,
  quote_sent_at: '2026-10-09T00:00:00Z', followup_step: 0, followup_fail_count: 0, ...o,
});

function fakeDeps({ settings = SETTINGS(), leads = [LEAD()], claim = true, replied = false, sendFails = false,
  updateThrowsTimes = 0, logThrows = false, repliedThrows = false } = {}) {
  const calls = { fetch: [], claim: [], update: [], log: [], send: [], alert: [] };
  let updateFailsLeft = updateThrowsTimes;
  return {
    calls,
    deps: {
      getSettings: async () => settings,
      fetchDue: async args => { calls.fetch.push(args); return leads; },
      claim: async (id, step) => { calls.claim.push([id, step]); return claim; },
      update: async (id, cols) => {
        calls.update.push([id, cols]);
        if (updateFailsLeft > 0) { updateFailsLeft--; throw new Error('db down'); }
        return true;
      },
      log: async row => { calls.log.push(row); if (logThrows) throw new Error('log down'); },
      sendEmail: async msg => { calls.send.push(msg); if (sendFails) throw new Error('gmail down'); return 'msg-1'; },
      hasReplied: async () => { if (repliedThrows) throw new Error('reply check down'); return replied; },
      alertOwner: async lead => { calls.alert.push(lead.id); },
    },
  };
}

test('skips entirely when disabled or outside the send window', async () => {
  let f = fakeDeps({ settings: SETTINGS({ enabled: false }) });
  assert.deepEqual(await runFollowups({ now: NOW, deps: f.deps }), { skipped: 'disabled' });
  f = fakeDeps();
  assert.deepEqual(await runFollowups({ now: LATE, deps: f.deps }), { skipped: 'outside_window' });
  assert.equal(f.calls.send.length, 0);
});

test('not set up (no settings row) → skipped', async () => {
  const f = fakeDeps({ settings: null });
  assert.deepEqual(await runFollowups({ now: NOW, deps: f.deps }), { skipped: 'not_set_up' });
});

test('sends a due step, logs it and schedules the next one', async () => {
  const f = fakeDeps();
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.sent, 1);
  assert.equal(f.calls.send[0].to, 'jane@x.com');
  assert.equal(f.calls.send[0].subject, 'S1');
  assert.equal(f.calls.send[0].text, 'Hi Jane');
  assert.match(f.calls.send[0].html, /<p /);
  assert.deepEqual(f.calls.log[0], { lead_id: 'L1', step: 1, to_email: 'jane@x.com', test_mode: false, gmail_message_id: 'msg-1' });
  assert.deepEqual(f.calls.update[0], ['L1', { followup_step: 1, followup_next_at: '2026-10-15T00:00:00.000Z', followup_fail_count: 0 }]);
});

test('final step closes the lead as Refused', async () => {
  const f = fakeDeps({ leads: [LEAD({ followup_step: 2 })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.update[0][1].lead_status, 'Refused');
  assert.equal(f.calls.update[0][1].refusal_reason, 'no_response');
  assert.equal(f.calls.update[0][1].followup_status, 'completed');
});

test('a lost claim sends nothing and writes nothing', async () => {
  const f = fakeDeps({ claim: false });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.sent, 0);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.calls.update.length, 0);
});

test('a customer reply stops the sequence and alerts the owner instead of sending', async () => {
  const f = fakeDeps({ replied: true });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.replied, 1);
  assert.equal(f.calls.send.length, 0);
  assert.deepEqual(f.calls.update[0], ['L1', { followup_status: 'replied', followup_stop_reason: 'replied', followup_next_at: null }]);
  assert.deepEqual(f.calls.alert, ['L1']);
});

test('send failure is logged and retried; the third failure marks error', async () => {
  let f = fakeDeps({ sendFails: true });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.errors, 1);
  assert.equal(f.calls.log[0].error, 'gmail down');
  assert.deepEqual(f.calls.update[0], ['L1', { followup_fail_count: 1, followup_next_at: '2026-10-12T01:00:00.000Z' }]);
  f = fakeDeps({ sendFails: true, leads: [LEAD({ followup_fail_count: 2 })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.update[0][1].followup_status, 'error');
});

test('test mode only fetches TEST leads and redirects to the test inbox', async () => {
  const f = fakeDeps({ settings: SETTINGS({ test_mode: true }), leads: [LEAD({ client_name: 'TEST Full Run' })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.fetch[0].testOnly, true);
  assert.equal(f.calls.send[0].to, 'owner@test.com');
  assert.equal(f.calls.log[0].test_mode, true);
});

test('held real leads are not claimed or touched in test mode', async () => {
  const f = fakeDeps({ settings: SETTINGS({ test_mode: true }), leads: [LEAD()] });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.held, 1);
  assert.equal(f.calls.claim.length, 0);
  assert.equal(f.calls.update.length, 0);
});

test('a lead with no usable email is parked as no_email', async () => {
  const f = fakeDeps({ leads: [LEAD({ email: '' })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.deepEqual(f.calls.update[0], ['L1', { followup_status: 'no_email', followup_next_at: null }]);
  assert.equal(f.calls.send.length, 0);
});

test('a successful send whose step-advance update throws once is retried; the send still counts', async () => {
  const f = fakeDeps({ updateThrowsTimes: 1 });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.update.length, 2);
  assert.equal(f.calls.update[1][1].followup_step, 1);
  assert.equal(out.sent, 1);
  assert.equal(f.calls.log.length, 1);
});

test('a successful send whose log write throws still advances the step and counts the send', async () => {
  const f = fakeDeps({ logThrows: true });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.sent, 1);
  assert.equal(f.calls.update[0][1].followup_step, 1);
});

test('a failed send whose error log throws still records the failure count', async () => {
  const f = fakeDeps({ sendFails: true, logThrows: true });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.deepEqual(f.calls.update[0], ['L1', { followup_fail_count: 1, followup_next_at: '2026-10-12T01:00:00.000Z' }]);
});

test('a reply-check error fails closed: nothing is sent or written', async () => {
  const f = fakeDeps({ repliedThrows: true });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.errors, 1);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.calls.update.length, 0);
});

test('dry run reports the plan without claiming/sending — even when disabled and outside the window', async () => {
  const f = fakeDeps({ settings: SETTINGS({ enabled: false }) });
  const out = await runFollowups({ dry: true, now: LATE, deps: f.deps });
  assert.equal(out.dry, true);
  assert.equal(out.enabled, false);
  assert.equal(out.inWindow, false);
  assert.deepEqual(out.actions, [{ id: 'L1', name: 'Jane Smith', step: 0, type: 'send', to: 'jane@x.com' }]);
  assert.equal(f.calls.claim.length + f.calls.send.length + f.calls.update.length, 0);
});
