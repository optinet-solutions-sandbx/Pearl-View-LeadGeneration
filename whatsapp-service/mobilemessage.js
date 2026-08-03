/**
 * mobilemessage.js — add a lead's phone to the Mobile Message broadcast list
 * at INGESTION time. Form/call/Facebook leads are created by this service and
 * bypass the dashboard's per-lead sync hook, so without this they'd only reach
 * the SMS audience via the Contacts-page backstop. This adds them immediately.
 *
 * Best-effort: NEVER throws to the caller — a Mobile Message hiccup must not
 * break lead ingestion. Skips silently if MM env vars aren't set.
 *
 * Env (Cloud Run): MM_USERNAME, MM_API_PASSWORD, MM_LIST_ID.
 */
const axios = require('axios');

const MM_BASE = 'https://api.mobilemessage.com.au/v1';

// Same normalisation the Vercel MM endpoints use → AU numbers become 61XXXXXXXXX
// so the same phone is never stored twice under different formats.
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

/**
 * Ensure a phone is a Mobile Message contact AND a member of the broadcast list.
 * If the contact already exists we DO NOT overwrite its name/date (a manually
 * uploaded contact may have better data) — we only ensure list membership.
 * @returns {Promise<{ok:boolean, ...}>} — resolves; never rejects.
 */
async function syncContactToList({ phone, name, email, date } = {}) {
  const USER = (process.env.MM_USERNAME || '').trim();
  const PASS = (process.env.MM_API_PASSWORD || '').trim();
  const LIST = Number(process.env.MM_LIST_ID || 0);
  if (!USER || !PASS || !LIST) return { ok: false, skipped: 'mm-env-missing' };

  const num = normalisePhone(phone);
  if (!num || num.length < 10) return { ok: false, skipped: 'invalid-phone' };

  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const basic = { Authorization: `Basic ${auth}` };
  const jsonH = { ...basic, 'Content-Type': 'application/json' };

  try {
    // Already a contact? Leave its name/date alone; just ensure list membership.
    let existing = null;
    try {
      const look = await axios.get(`${MM_BASE}/contacts?number=${encodeURIComponent(num)}&limit=1`,
        { headers: basic, timeout: 8000 });
      existing = Array.isArray(look.data?.results) && look.data.results.length ? look.data.results[0] : null;
    } catch (_) { /* lookup failure → treat as new; create is idempotent enough */ }

    if (!existing) {
      const { first, last } = splitName(name);
      const ymd = toYmd(date) || toYmd(new Date());
      const body = { number: num };
      if (first) body.first_name = first;
      if (last)  body.last_name  = last;
      if (email) body.other      = email;
      if (ymd)   body.field_1    = ymd;
      try {
        await axios.post(`${MM_BASE}/contacts`, body, { headers: jsonH, timeout: 8000 });
      } catch (e) {
        console.error(`[mm-sync] create failed for ${num}: ${e.response?.status || e.message}`);
      }
    }

    const lr = await axios.post(`${MM_BASE}/list-contacts`, { list_id: LIST, number: num },
      { headers: jsonH, timeout: 8000 });
    return { ok: lr.status >= 200 && lr.status < 300, phone: num, wasExisting: !!existing };
  } catch (e) {
    console.error(`[mm-sync] list add failed for ${num}: ${e.response?.status || e.message}`);
    return { ok: false, phone: num, error: e.message };
  }
}

module.exports = { syncContactToList, normalisePhone };
