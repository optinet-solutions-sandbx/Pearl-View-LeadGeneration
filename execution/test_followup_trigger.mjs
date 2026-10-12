/* Live check of the follow-up enrollment trigger + guarded engine updates.
   Run AFTER execution/supabase_followups.sql:
     node --env-file=.env execution/test_followup_trigger.mjs     (exit 0 = pass)
   Creates leads named "TEST Trigger …", deletes them at the end, and restores
   followup_settings.enabled. While it runs (seconds) the feature is ON — any real
   lead quoted in that window is enrolled but HELD by test mode. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.USE_SUPABASE = 'true';
const require = createRequire(import.meta.url);
const sb = require('../whatsapp-service/sb.js');

const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_ROLE;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
async function rest(method, path, body) {
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
const insertLead = async f => (await rest('POST', 'leads', f))[0];
const patchLead = async (id, f) => (await rest('PATCH', `leads?id=eq.${id}`, f))[0];
const getLead = async (id, cols) => (await rest('GET', `leads?id=eq.${id}&select=${cols}`))[0];
const setEnabled = enabled => rest('PATCH', 'followup_settings?id=eq.1', { enabled });

const [orig] = await rest('GET', 'followup_settings?id=eq.1&select=enabled,steps');
assert.ok(orig, 'followup_settings row missing — run execution/supabase_followups.sql first');
const d1 = Number(orig.steps[0].delay_hours);
const created = [];
const EMAIL = 'trigger-check@example.com';

try {
  await setEnabled(true);

  // 1. entering Quote Sent with an email → active, step 0, next_at = quote_sent_at + step-1 delay
  let a = await insertLead({ client_name: 'TEST Trigger Active', email: EMAIL, lead_status: 'New Lead' });
  created.push(a.id);
  assert.equal(a.followup_status, null);
  a = await patchLead(a.id, { lead_status: 'Quote Sent' });
  assert.equal(a.followup_status, 'active');
  assert.equal(a.followup_step, 0);
  assert.ok(a.quote_sent_at);
  const hrs = (new Date(a.followup_next_at) - new Date(a.quote_sent_at)) / 3600e3;
  assert.ok(Math.abs(hrs - d1) < 0.01, `next_at should be +${d1}h, got +${hrs}h`);

  // 2. owner moves it on → stopped; a guarded engine update can no longer touch it
  a = await patchLead(a.id, { lead_status: 'Booked' });
  assert.equal(a.followup_status, 'stopped');
  assert.equal(a.followup_stop_reason, 'status_changed');
  assert.equal(await sb.updateActiveFollowup(a.id, { lead_status: 'Refused', followup_status: 'completed' }), false);
  assert.equal((await getLead(a.id, 'lead_status')).lead_status, 'Booked');

  // 3. the engine's final update (Refused + completed in one statement) is not overridden by the trigger
  const c = await insertLead({ client_name: 'TEST Trigger Close', email: EMAIL, lead_status: 'Quote Sent' });
  created.push(c.id);
  assert.equal(c.followup_status, 'active');
  assert.equal(await sb.updateActiveFollowup(c.id, {
    lead_status: 'Refused', refusal_reason: 'no_response', followup_status: 'completed', followup_step: 3,
  }), true);
  assert.deepEqual(await getLead(c.id, 'lead_status,followup_status'), { lead_status: 'Refused', followup_status: 'completed' });

  // 4. no email → no_email; adding an email activates it
  let n = await insertLead({ client_name: 'TEST Trigger NoEmail', lead_status: 'Quote Sent' });
  created.push(n.id);
  assert.equal(n.followup_status, 'no_email');
  n = await patchLead(n.id, { email: EMAIL });
  assert.equal(n.followup_status, 'active');

  // 5. feature off → quote_sent_at still stamped, not enrolled
  await setEnabled(false);
  const o = await insertLead({ client_name: 'TEST Trigger Off', email: EMAIL, lead_status: 'Quote Sent' });
  created.push(o.id);
  assert.equal(o.followup_status, null);
  assert.ok(o.quote_sent_at);

  // 6. the dashboard view exposes the new columns (and still has the payment join)
  const [v] = await rest('GET', `leads_enriched?id=eq.${o.id}&select=id,quote_sent_at,followup_status,followup_step,followup_next_at,paid`);
  assert.ok(v && 'followup_status' in v && 'paid' in v, 'leads_enriched is missing follow-up columns');

  console.log('PASS — follow-up trigger + guarded updates behave as designed');
} finally {
  for (const id of created) await rest('DELETE', `leads?id=eq.${id}`).catch(e => console.error('cleanup failed', id, e.message));
  await setEnabled(orig.enabled);
}
