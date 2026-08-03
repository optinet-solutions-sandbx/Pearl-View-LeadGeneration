const axios = require('axios');
const { DASHBOARD_URL, NOTIFY_FOOTER } = require('./config');

const BASE_URL = 'https://api.green-api.com';

let cachedState = { value: null, checkedAt: 0 };
const STATE_CACHE_MS = 60 * 1000;

async function getInstanceState() {
  const idInstance = process.env.GREENAPI_INSTANCE_ID;
  const apiToken = process.env.GREENAPI_TOKEN;
  if (!idInstance || !apiToken) return 'notConfigured';

  const now = Date.now();
  if (cachedState.value && now - cachedState.checkedAt < STATE_CACHE_MS) {
    return cachedState.value;
  }

  try {
    const url = `${BASE_URL}/waInstance${idInstance}/getStateInstance/${apiToken}`;
    const r = await axios.get(url, { timeout: 8000 });
    const state = r.data?.stateInstance || 'unknown';
    cachedState = { value: state, checkedAt: now };
    return state;
  } catch (e) {
    cachedState = { value: 'error', checkedAt: now };
    return 'error';
  }
}

function buildLeadMessage({ name, phone, email, subject, source, time }) {
  return [
    '*🔔 New lead received*',
    '',
    'A new customer enquiry has arrived in your lead inbox.',
    '',
    `*Name:* ${name || '—'}`,
    `*Phone:* ${phone || '—'}`,
    `*Email:* ${email || '—'}`,
    `*Subject:* ${subject || '—'}`,
    `*Source:* ${source || '—'}`,
    `*Time:* ${time}`,
    '',
    '👉 Open in app:',
    DASHBOARD_URL,
    '',
    `_${NOTIFY_FOOTER}_`,
  ].join('\n');
}

async function sendLeadNotification(to, lead) {
  const idInstance = process.env.GREENAPI_INSTANCE_ID;
  const apiToken = process.env.GREENAPI_TOKEN;
  if (!idInstance || !apiToken) {
    throw new Error('GREENAPI_INSTANCE_ID or GREENAPI_TOKEN not set');
  }

  const chatId = `${to}@c.us`;
  const message = buildLeadMessage(lead);
  const url = `${BASE_URL}/waInstance${idInstance}/sendMessage/${apiToken}`;

  const response = await axios.post(url, { chatId, message, linkPreview: true }, {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

module.exports = { sendLeadNotification, buildLeadMessage, getInstanceState };
