/**
 * GET /api/mm-list-info
 *
 * Returns metadata the BroadcastPage needs before letting the owner send:
 *   - list: { list_id, name, contact_count }
 *   - senders: [{ sender, type, label, is_default }]
 *   - balance: { credits } (best-effort; omitted if endpoint unavailable)
 */
import https from 'https';

function mmRequest(method, path, auth) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.mobilemessage.com.au',
        path, method,
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      },
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
    req.end();
  });
}

export default async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const USER = (process.env.MM_USERNAME || '').trim();
  const PASS = (process.env.MM_API_PASSWORD || '').trim();
  const LIST_ID = (process.env.MM_LIST_ID || '').trim();

  if (!USER || !PASS || !LIST_ID) {
    return res.status(500).json({ error: 'MM env vars missing' });
  }

  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');

  const [listsRes, sendersRes, balanceRes] = await Promise.all([
    mmRequest('GET', '/v1/lists', auth).catch(() => null),
    mmRequest('GET', '/v1/senders', auth).catch(() => null),
    mmRequest('GET', '/v1/balance', auth).catch(() => null),
  ]);

  const lists = listsRes?.data?.results || [];
  const list  = lists.find(l => String(l.list_id) === LIST_ID) || null;
  const senders = sendersRes?.data?.results || [];
  const balance = balanceRes?.status === 200 ? balanceRes.data : null;

  return res.status(200).json({ list, senders, balance });
};
