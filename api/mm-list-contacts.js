/**
 * GET /api/mm-list-contacts
 *
 * Returns every contact in the broadcast list (MM_LIST_ID) so the dashboard
 * Contacts page can show name + phone + intake date. Paginates server-side
 * (MM caps results at 200/req) and returns one merged array.
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Pragma');
  // Aggressively prevent caching — iOS Safari has been observed to serve
  // stale empty responses from disk cache even with must-revalidate.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const USER = (process.env.MM_USERNAME || '').trim();
  const PASS = (process.env.MM_API_PASSWORD || '').trim();
  const LIST_ID = (process.env.MM_LIST_ID || '').trim();

  if (!USER || !PASS || !LIST_ID) {
    return res.status(500).json({ error: 'MM env vars missing' });
  }

  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');
  const limit = 200;
  let offset = 0;
  const results = [];

  while (true) {
    const r = await mmRequest(
      'GET',
      `/v1/list-contacts?list_id=${LIST_ID}&limit=${limit}&offset=${offset}`,
      auth
    ).catch(e => ({ status: 0, data: { error: e.message } }));

    if (r.status !== 200) {
      return res.status(r.status || 500).json(r.data);
    }

    const batch = r.data?.results || [];
    results.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
    if (offset > 10_000) break; // safety
  }

  return res.status(200).json({ list_id: Number(LIST_ID), total: results.length, results });
};
