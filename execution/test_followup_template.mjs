/* Standalone tests for the frontend follow-up helpers, plus parity with the
   sender (whatsapp-service/followup-core.js) and the SQL seed.
   Run: node execution/test_followup_template.mjs   (exit 0 = pass) */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as fe from '../src/utils/followupTemplate.js';

const require = createRequire(import.meta.url);
const be = require('../whatsapp-service/followup-core.js');

// ── parity: the Settings preview renders exactly what the sender sends ──────
for (const lead of [
  { client_name: 'Jane Smith', quote_amount: 350 },
  { client_name: 'Unknown Caller', quote_amount: 0 },
  { client_name: '—', quote_amount: 1234.5 },
  { client_name: 'TEST Full Run', quote_amount: '980' },
  { client_name: 'Testa Smith', quote_amount: null },
]) {
  assert.equal(fe.firstName(lead.client_name), be.firstName(lead.client_name), `firstName ${lead.client_name}`);
  assert.equal(fe.formatMoney(lead.quote_amount), be.formatMoney(lead.quote_amount), `formatMoney ${lead.quote_amount}`);
  assert.equal(fe.isTestLead(lead.client_name), be.isTestLead(lead.client_name), `isTestLead ${lead.client_name}`);
  const ctx = be.buildContext(lead, { sender_name: 'Brad', company_name: 'Pearlview Window Cleaning' }, 'x');
  for (const s of fe.DEFAULT_STEPS) {
    assert.equal(fe.renderTemplate(s.subject, ctx), be.renderTemplate(s.subject, ctx));
    assert.equal(fe.renderTemplate(s.body, ctx), be.renderTemplate(s.body, ctx));
  }
}

// ── parity: SQL seed == DEFAULT_STEPS ("Reset to default scripts") ──────────
const sql = readFileSync(new URL('./supabase_followups.sql', import.meta.url), 'utf8');
assert.deepEqual(JSON.parse(sql.split('$steps$')[1]), fe.DEFAULT_STEPS, 'SQL seed must equal DEFAULT_STEPS');

// ── validateSettings ─────────────────────────────────────────────────────────
const good = {
  enabled: true, test_mode: true, test_email: 'john@x.com', sender_name: 'Pearlview', company_name: 'Pearlview',
  window_start_hour: 8, window_end_hour: 18, steps: fe.DEFAULT_STEPS.map(s => ({ ...s })),
};
assert.deepEqual(fe.validateSettings(good), []);
assert.match(fe.validateSettings({ ...good, test_email: '' })[0], /test email/i);
assert.deepEqual(fe.validateSettings({ ...good, test_mode: false, test_email: '' }), []);
assert.match(fe.validateSettings({ ...good, window_start_hour: 18, window_end_hour: 8 })[0], /send window/i);
assert.match(fe.validateSettings({ ...good, sender_name: ' ' })[0], /signature/i);
const badStep = { ...good, steps: good.steps.map((s, i) => (i === 1 ? { ...s, subject: '', delay_hours: 0 } : s)) };
assert.deepEqual(fe.validateSettings(badStep), ['Follow-up 2: subject is empty.', 'Follow-up 2: wait must be at least 1 hour.']);
const hugeStep = { ...good, steps: good.steps.map((s, i) => (i === 0 ? { ...s, delay_hours: 9000 } : s)) };
assert.deepEqual(fe.validateSettings(hugeStep), ['Follow-up 1: wait must be at most 365 days.']);
const offStep = { ...good, steps: good.steps.map((s, i) => (i === 1 ? { ...s, enabled: false, subject: '' } : s)) };
assert.deepEqual(fe.validateSettings(offStep), [], 'disabled steps are not validated');

// ── followupChip ─────────────────────────────────────────────────────────────
const S = { ...good, test_mode: false };
const L = o => ({ status: 'quote_sent', name: 'Jane', email: 'j@x.com', followupStatus: 'active', followupStep: 1, ...o });
assert.equal(fe.followupChip(L(), S).label, 'FU 1/3');
assert.equal(fe.followupChip(L(), { ...S, test_mode: true }).label, 'Held');
assert.equal(fe.followupChip(L({ name: 'TEST x' }), { ...S, test_mode: true }).label, 'FU 1/3');
assert.equal(fe.followupChip(L({ followupStatus: 'replied' }), S).label, 'Replied');
assert.equal(fe.followupChip(L({ followupStatus: 'no_email' }), S).label, 'No email');
assert.equal(fe.followupChip(L({ followupStatus: 'stopped' }), S).label, 'FU stopped');
assert.equal(fe.followupChip(L({ followupStatus: 'error' }), S).label, 'FU failed');
assert.equal(fe.followupChip(L({ followupStatus: null }), S), null);
assert.equal(fe.followupChip(L({ status: 'booked' }), S), null);
assert.equal(fe.followupChip(L(), null), null);

// ── describeFollowup → which button the panel offers ────────────────────────
const D = (o, s = S) => fe.describeFollowup(L(o), s, new Date('2026-10-12T00:00:00Z'));
assert.equal(D({}).action, 'stop');
assert.equal(D({ followupStatus: null }).action, 'start');
assert.equal(D({ followupStatus: null, email: '' }).action, null);
assert.equal(D({ followupStatus: 'stopped' }).action, 'resume');
assert.equal(D({ followupStatus: 'replied' }).action, 'resume');
assert.equal(D({ followupStatus: 'error' }).action, 'resume');
assert.equal(D({ followupStatus: 'no_email', email: '' }).action, null);
assert.equal(D({ followupStatus: 'no_email' }).action, 'resume', 'email fixed after the engine parked it');
assert.equal(D({ followupStatus: 'stopped', followupStep: 3 }).action, null, 'nothing left to send');
assert.equal(D({ followupStatus: 'completed', status: 'refused' }).action, null);
assert.match(D({}, { ...S, test_mode: true }).text, /Held/);
assert.match(D({ followupStatus: 'completed', status: 'refused' }).text, /no response/i);
assert.equal(fe.describeFollowup(L({ status: 'booked', followupStatus: 'stopped' }), S), null, 'hidden once the lead moves on');
assert.equal(fe.describeFollowup(L(), null), null, 'hidden when follow-ups are not set up');

assert.match(D({}, { ...S, enabled: false }).text, /Paused/);
assert.equal(D({}, { ...S, enabled: false }).action, 'stop');
assert.equal(D({ followupStatus: null, email: 'Jane <jane@x.com>' }).action, 'start', 'name-and-address email counts');

// ── followupStartPatch ──────────────────────────────────────────────────────
const NOW = '2026-10-12T01:00:00.000Z';
const p1 = fe.followupStartPatch({ followupStatus: null, followupStep: 0, quoteSentAt: null }, NOW);
assert.equal(p1.local.followupStep, 0);
assert.equal(p1.local.quoteSentAt, NOW);
assert.equal(p1.fields['Quote Sent At'], NOW);
assert.equal(p1.fields['Follow-up Status'], 'active');
assert.equal(p1.fields['Follow-up Fail Count'], 0);
assert.equal(p1.fields['Follow-up Stop Reason'], null);
const p2 = fe.followupStartPatch({ followupStatus: 'stopped', followupStep: 2, quoteSentAt: 'X' }, NOW);
assert.equal(p2.local.followupStep, 2);
assert.equal(p2.local.quoteSentAt, 'X');
const p3 = fe.followupStartPatch({ followupStatus: 'replied', followupStep: 1, quoteSentAt: 'X' }, NOW);
assert.equal(p3.local.followupStep, 1);
assert.equal(p3.local.quoteSentAt, NOW, 'resume after reply resets the reply baseline');
assert.equal(p3.fields['Follow-up Step'], 1);

console.log('PASS — followupTemplate');
