/**
 * POST /api/mm-send-broadcast
 * Body: { message, sender, scheduledFor?, customRef? }
 *
 * Sends an SMS broadcast to every contact on MM_LIST_ID via Mobile Message's
 * /v1/list-send endpoint. Unsubscribed numbers are auto-filtered by MM.
 *
 * Returns whatever MM returned (with status code surfaced to the client) so
 * the UI can show recipient_count, cost, send_id, and any validation errors.
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
    return res.status(500).json({ error: 'MM env vars missing' });
  }

  let body = '';
  req.on('data', c => (body += c));
  await new Promise(r => req.on('end', r));

  let payload = {};
  try { payload = JSON.parse(body || '{}'); }
  catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const message = String(payload.message || '').trim();
  const sender  = String(payload.sender  || '').trim();
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (!sender)  return res.status(400).json({ error: 'Sender is required' });

  const auth = Buffer.from(`${USER}:${PASS}`).toString('base64');

  const sendBody = {
    list_id: Number(LIST_ID),
    sender,
    message,
  };
  if (payload.scheduledFor) sendBody.scheduled_for = payload.scheduledFor;
  if (payload.customRef)    sendBody.custom_ref    = payload.customRef;
  // Stagger over 5 minutes for any send to 50+ recipients (MM requirement)
  // — soft cap to spread carrier load and avoid spam-trap heuristics.
  sendBody.stagger_minutes = 5;

  const result = await mmRequest('POST', '/v1/list-send', sendBody, auth).catch(e => ({
    status: 0, data: { error: e.message },
  }));

  return res.status(result.status || 500).json(result.data);
};
