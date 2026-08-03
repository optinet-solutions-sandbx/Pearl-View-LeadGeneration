const axios = require('axios');

const BASE_URL = 'https://graph.facebook.com/v18.0';

/**
 * Send a WhatsApp text message
 */
async function sendMessage(to, text) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;

  const response = await axios.post(
    `${BASE_URL}/${phoneNumberId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return response.data;
}

/**
 * Send a new lead notification.
 * Tiered fallback: primary template → backup template → plain text.
 * Primary (v1) has the "Open in app" URL button.
 * Backup (v3) is text-only with inline URL — used if v1 is unavailable/rejected.
 */
async function sendLeadNotification(to, { name, phone, email, subject, source, time }) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_TOKEN;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const url = `${BASE_URL}/${phoneNumberId}/messages`;

  const bodyParameters = [
    { type: 'text', text: name    || '—' },
    { type: 'text', text: phone   || '—' },
    { type: 'text', text: email   || '—' },
    { type: 'text', text: subject || '—' },
    { type: 'text', text: source  || '—' },
    { type: 'text', text: time },
  ];

  // Per-deployment template names (a second WABA has its own approved templates).
  const templateNames = (process.env.WHATSAPP_TEMPLATE_NAMES || 'pearl_view_new_lead,pearl_view_new_lead_v3')
    .split(',').map(s => s.trim()).filter(Boolean);

  for (const templateName of templateNames) {
    try {
      const response = await axios.post(url, {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: 'en' },
          components: [{ type: 'body', parameters: bodyParameters }],
        },
      }, { headers });
      return response.data;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      console.log(`Template ${templateName} failed (code ${code}), trying next fallback`);
    }
  }

  // Final fallback: formatted plain text (only works within 24h customer service window)
  const text = [
    '🔔 *New Lead Alert!*',
    '',
    `*Name:* ${name || '—'}`,
    `*Phone:* ${phone || '—'}`,
    `*Email:* ${email || '—'}`,
    `*Subject:* ${subject || '—'}`,
    `*Source:* ${source || '—'}`,
    `*Time:* ${time}`,
  ].join('\n');

  const response = await axios.post(url, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { preview_url: false, body: text },
  }, { headers });
  return response.data;
}

/**
 * Verify Meta webhook handshake (GET /webhook)
 * Returns the hub.challenge value if verify token matches, null otherwise
 */
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

/**
 * Extract the first text message and sender from a Meta webhook POST body
 * Returns null if the payload is not a text message
 */
function extractIncomingMessage(body) {
  try {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== 'text') return null;

    return {
      from: message.from,           // sender phone number
      text: message.text.body,      // message text
      messageId: message.id,
    };
  } catch {
    return null;
  }
}

module.exports = { sendMessage, sendLeadNotification, verifyWebhook, extractIncomingMessage };
