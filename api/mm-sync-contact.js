/**
 * POST /api/mm-sync-contact
 * Body: { phone, firstName, lastName, email, inquiryDate }
 *
 * Syncs a phone number to the Mobile Message broadcast list (MM_LIST_ID).
 * - If the contact already exists in Mobile Message, we DO NOT overwrite
 *   their name/date (the user has pre-existing MM contacts uploaded directly
 *   that don't have a date — we leave those alone). We only ensure they're
 *   in the broadcast list.
 * - If the contact is new, we create it with first_name, last_name, and
 *   field_1 = inquiryDate (YYYY-MM-DD), then add it to the list.
 *
 * Idempotent. Failures never block the caller — always returns 200 with
 * { ok, ... } so the dashboard's create-lead flow keeps working.
 */
import https from 'https';

function mmRequest(method, path, body, auth) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const headers = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      { hostname: 'api.mobilemessage.com.au', path, method, headers },
      res => {
        let data = '';
        res.on('data', c => (data += c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(data); } catch (_) { parsed = { raw: data }; }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalisePhone(input) {
  if (!input) return '';
  let s = String(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '61' + s.slice(1);
  if (s.length === 9 && s.startsWith('4')) s = '61' + s;
  return s;
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function toYmd(input) {
  if (!input) return '';
  const d = new Date(input);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const USER = (process.env.MM_USERNAME || '').trim();
  const PASS = (process.env.MM_API_PASSWORD || '').trim();
  const LIST_ID = (process.env.MM_LIST_ID || '').trim();

  if (!USER || !PASS || !LIST_ID) {
    return res.status(200).json({ ok: false, skipped: true, reason: 'MM env vars missing' });
  }

  let body = '';
  req.on('data', c => (body += c));
  await new Promise(r => req.on('end', r));

  let payload = {};
  try { payload = JSON.parse(body || '{}'); }
  catch (e) { return res.status(400).json({ ok: false, error: 'Invalid JSON' }); }

  const phone = normalisePhone(payload.phone);
  if (!phone || phone.length < 10) {
    return res.status(200).json({ ok: false, skipped: true, reason: 'Invalid phone' });
  }

  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');

  // Check if the contact already exists in MM (someone the user uploaded
  // previously). If so, we leave their name/date alone.
  const lookup = await mmRequest(
    'GET',
    `/v1/contacts?number=${encodeURIComponent(phone)}&limit=1`,
    null, auth
  ).catch(e => ({ status: 0, data: { error: e.message } }));

  const existing =
    lookup.data && Array.isArray(lookup.data.results) && lookup.data.results.length > 0
      ? lookup.data.results[0]
      : null;

  let contactRes = { status: 200, data: { existing: true, contact: existing } };

  if (!existing) {
    let firstName = (payload.firstName || '').trim();
    let lastName  = (payload.lastName  || '').trim();
    if (!firstName && payload.name) {
      const split = splitName(payload.name);
      firstName = split.first;
      lastName  = split.last;
    }
    const ymd = toYmd(payload.inquiryDate) || toYmd(new Date());

    const contactBody = { number: phone };
    if (firstName) contactBody.first_name = firstName;
    if (lastName)  contactBody.last_name  = lastName;
    if (payload.email) contactBody.other  = payload.email;
    if (ymd) contactBody.field_1 = ymd;

    contactRes = await mmRequest('POST', '/v1/contacts', contactBody, auth).catch(e => ({
      status: 0, data: { error: e.message },
    }));
  }

  const listRes = await mmRequest('POST', '/v1/list-contacts', {
    list_id: Number(LIST_ID),
    number: phone,
  }, auth).catch(e => ({ status: 0, data: { error: e.message } }));

  const listOk = listRes.status >= 200 && listRes.status < 300;

  return res.status(200).json({
    ok: listOk,
    phone,
    wasExisting: !!existing,
    contact: { status: contactRes.status, data: contactRes.data },
    list: { status: listRes.status, data: listRes.data },
  });
};
