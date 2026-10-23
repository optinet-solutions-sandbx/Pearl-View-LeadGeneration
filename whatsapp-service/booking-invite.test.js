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

const { inviteRequestBody } = require('./booking');
const { eventIdFor } = require('./calendar-core');

test('inviteRequestBody passes the deterministic id only when Google accepts it', () => {
  const uuid = '3F2A9C10-1B2C-4D5E-8F90-ABCDEF123456';
  const sbBody = inviteRequestBody({ ...args, bookingId: uuid });
  assert.equal(sbBody.id, eventIdFor(uuid, 0));
  assert.equal(sbBody.start.dateTime, '2026-11-06T09:00:00');
  const atBody = inviteRequestBody({ ...args, bookingId: 'recWxYz12345678' }); // Airtable rollback id → w/x/y/z invalid
  assert.equal('id' in atBody, false);
  assert.equal(atBody.start.dateTime, '2026-11-06T09:00:00');
  assert.deepEqual(atBody.attendees, [{ email: 'j@x.com', displayName: 'J' }]);
});

// createRebooking stores the event's address + the lead link on the booking it creates
// (Supabase only — the old Airtable Bookings table has neither field). No email → no Google call.
const sb = require('./sb');
const axios = require('axios');
const { signToken } = require('./token');
const { createRebooking } = require('./booking');
const LEAD_ID = '3f2a9c10-1b2c-4d5e-8f90-abcdef123456';
const LEAD_FIELDS = { 'Client Name': 'Jane', 'Phone Number': '0400 111 222', 'Service Address': '1 A St', 'City': 'Byron' };
const MONDAY = '2099-01-05';

test('createRebooking (Supabase) stores Service Address and Lead Id', async (t) => {
  const was = sb.USE_SUPABASE;
  sb.USE_SUPABASE = true;
  t.after(() => { sb.USE_SUPABASE = was; });
  t.mock.method(sb, 'getLeadById', async id => ({ id, fields: LEAD_FIELDS }));
  t.mock.method(sb, 'fetchActiveBookings', async () => []);
  const created = [];
  t.mock.method(sb, 'createBooking', async f => { created.push(f); return 'b-new'; });
  const r = await createRebooking({ t: signToken({ leadId: LEAD_ID }), date: MONDAY });
  assert.equal(r.inviteSent, false);
  assert.equal(created.length, 1);
  assert.equal(created[0]['Service Address'], '1 A St');
  assert.equal(created[0]['Lead Id'], LEAD_ID);
});

test('createRebooking (Airtable rollback) sends neither field', async (t) => {
  const was = sb.USE_SUPABASE;
  sb.USE_SUPABASE = false;
  t.after(() => { sb.USE_SUPABASE = was; });
  t.mock.method(axios, 'get', async url => (url.endsWith('/recLead')
    ? { data: { id: 'recLead', fields: LEAD_FIELDS } }   // the lead
    : { data: { records: [] } }));                        // the bookings list
  const posted = [];
  t.mock.method(axios, 'post', async (url, body) => { posted.push(body); return { data: { id: 'recNew' } }; });
  await createRebooking({ t: signToken({ leadId: 'recLead' }), date: MONDAY });
  assert.equal(posted.length, 1);
  assert.equal('Service Address' in posted[0].fields, false);
  assert.equal('Lead Id' in posted[0].fields, false);
});
