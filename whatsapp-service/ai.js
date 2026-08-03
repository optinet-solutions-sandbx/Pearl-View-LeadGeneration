const OpenAI = require('openai');
const { BRAND_NAME } = require('./config');

// Lazy-init: only create client when OPENAI_API_KEY is set (avoids crash on startup)
let client = null;
function getClient() {
  if (!client) {
    if (!process.env.OPENAI_API_KEY) return null;
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

/**
 * Generate an AI response using the lead stats context + user message
 */
async function generateReply(userMessage, context) {
  const {
    totalLeads, totalRevenue, totalQuoted,
    statusBreakdown, sourceBreakdown,
    recentLeads, refusalReasons, last100,
  } = context;

  const statusSummary = Object.entries(statusBreakdown).map(([k, v]) => `  - ${k}: ${v}`).join('\n');
  const sourceSummary = Object.entries(sourceBreakdown).map(([k, v]) => `  - ${k}: ${v}`).join('\n');
  const recentSummary = recentLeads.length
    ? recentLeads.map(l => `  - ${l.name} | ${l.status} | ${l.source} | ${l.date}`).join('\n')
    : '  None in the last 7 days';
  const refusalSummary = refusalReasons.length ? refusalReasons.slice(-10).join(', ') : 'None recorded';

  const systemPrompt = `You are an AI business assistant for ${BRAND_NAME}, a window cleaning company in Australia. You have access to the company's lead management data and can answer questions about their business performance.

Current Business Data:
- Total Leads: ${totalLeads}
- Total Revenue (Job Done): $${totalRevenue} AUD
- Total Quoted Value: $${totalQuoted} AUD

Lead Status Breakdown:
${statusSummary}

Lead Source Breakdown:
${sourceSummary}

Recent Leads (Last 7 Days):
${recentSummary}

Recent Refusal Reasons: ${refusalSummary}

Last 100 Leads (Name | Status | Amount | Source):
${last100.join('\n')}

Instructions:
- Answer questions about leads, revenue, bookings, and business performance
- Be concise — this is a WhatsApp conversation, keep replies short and clear
- Use numbers and specifics from the data above
- If asked about something not in the data, say you don't have that information
- Be friendly and professional`;

  const ai = getClient();
  if (!ai) return 'AI assistant is not configured. Please set OPENAI_API_KEY.';

  const response = await ai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return response.choices[0].message.content;
}

module.exports = { generateReply };
