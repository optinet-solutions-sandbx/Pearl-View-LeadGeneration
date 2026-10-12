// Quote follow-up helpers for the Settings page, the lead panel and lead cards.
// firstName / formatMoney / renderTemplate / isTestLead MUST behave exactly like
// whatsapp-service/followup-core.js (the sender), and DEFAULT_STEPS must equal
// the seed in execution/supabase_followups.sql — execution/test_followup_template.mjs
// enforces both.

const EMAIL_RE = /^[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+$/;
// Unanchored: same rule as the sender's cleanEmail ("Jane <jane@x.com>" is sendable).
const HAS_EMAIL_RE = /[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+/;
const NO_NAME = /^(unknown( caller)?|—|-|n\/a)?$/i;

export const PLACEHOLDERS = [
  { key: 'first_name', label: 'First name' },
  { key: 'client_name', label: 'Full name' },
  { key: 'company', label: 'Company' },
  { key: 'sender', label: 'Signature' },
  { key: 'quote_amount', label: 'Quote amount' },
];

export const DEFAULT_STEPS = [
  {
    enabled: true,
    delay_hours: 48,
    subject: "Quick check-in regarding your window cleaning quote!",
    body: "Hi {first_name},\n\nI hope you're having a great week! I just wanted to quickly follow up on the quote we sent over for your window cleaning.\n\nDid you have any questions about the service details or pricing? We'd love to get your windows sparkling clean!\n\nBest regards,\n{sender}",
  },
  {
    enabled: true,
    delay_hours: 72,
    subject: "Flexible scheduling available for your window cleaning",
    body: "Hi {first_name},\n\nFollowing up on my previous message! I wanted to let you know we have a few open spots available on our schedule for this coming week.\n\nIf you have a specific day or time in mind that works best for you, let us know and we'll be happy to reserve it for you.\n\nBest regards,\n{sender}",
  },
  {
    enabled: true,
    delay_hours: 120,
    subject: "Final check-in from {company}",
    body: "Hi {first_name},\n\nI haven't heard back from you, so I assume you may have put your window cleaning project on hold for now.\n\nI'll go ahead and close out your inquiry in our system so we don't bother you with further messages. If you ever need us in the future, please feel free to reach out anytime!\n\nWarm regards,\n{sender}",
  },
];

export const STEP_WAIT_LABELS = ['after the quote is sent', 'after follow-up 1', 'after follow-up 2'];

export function firstName(clientName) {
  const n = String(clientName || '').trim();
  return NO_NAME.test(n) ? 'there' : n.split(/\s+/)[0];
}

export function formatMoney(n) {
  const v = Number(n);
  if (!(v > 0)) return '';
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

export function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) =>
    (Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key] ?? '') : m));
}

export function isTestLead(name) {
  return /^\s*test\b/i.test(String(name || ''));
}

// Sample lead for the Settings preview.
export function sampleContext(settings) {
  const company = String(settings?.company_name || '').trim() || 'your company';
  return {
    first_name: 'Sarah',
    client_name: 'Sarah Mitchell',
    company,
    sender: String(settings?.sender_name || '').trim() || company,
    quote_amount: '$350',
  };
}

export function validateSettings(s) {
  const errs = [];
  if (s.test_mode && !EMAIL_RE.test(String(s.test_email || '').trim())) errs.push('Test mode needs a valid test email address.');
  if (!String(s.sender_name || '').trim()) errs.push('Signature is empty.');
  const a = s.window_start_hour;
  const b = s.window_end_hour;
  if (!(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b <= 24 && a < b)) errs.push('Send window: start hour must be before end hour.');
  (s.steps || []).forEach((st, i) => {
    if (st.enabled === false) return;
    if (!String(st.subject || '').trim()) errs.push(`Follow-up ${i + 1}: subject is empty.`);
    if (!String(st.body || '').trim()) errs.push(`Follow-up ${i + 1}: message is empty.`);
    if (!(Number(st.delay_hours) >= 1)) errs.push(`Follow-up ${i + 1}: wait must be at least 1 hour.`);
    if (Number(st.delay_hours) > 8760) errs.push(`Follow-up ${i + 1}: wait must be at most 365 days.`);
  });
  return errs;
}

const totalSteps = s => (Array.isArray(s?.steps) ? s.steps.length : 3);
const isHeld = (lead, s) => !!s?.test_mode && !isTestLead(lead.name);
const GREY = { bg: '#f3f4f6', color: '#4b5563' };

export function followupChip(lead, s) {
  if (!s || lead.status !== 'quote_sent' || !lead.followupStatus) return null;
  switch (lead.followupStatus) {
    case 'active':
      return isHeld(lead, s)
        ? { label: 'Held', bg: '#fef3c7', color: '#92400e' }
        : { label: `FU ${lead.followupStep || 0}/${totalSteps(s)}`, bg: '#ede9fe', color: '#6d28d9' };
    case 'replied':   return { label: 'Replied', bg: '#dcfce7', color: '#15803d' };
    case 'no_email':  return { label: 'No email', ...GREY };
    case 'stopped':   return { label: 'FU stopped', ...GREY };
    case 'error':     return { label: 'FU failed', bg: '#fee2e2', color: '#b91c1c' };
    case 'completed': return { label: 'FU done', ...GREY };
    default:          return null;
  }
}

const fmtWhen = iso => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};

// Status line + the one button the lead panel should offer (null = hide section).
export function describeFollowup(lead, s, now = new Date()) {
  if (!s) return null;
  const closed = lead.status === 'refused' && lead.followupStatus === 'completed';
  if (lead.status !== 'quote_sent' && !closed) return null;

  const total = totalSteps(s);
  const step = lead.followupStep || 0;
  const hasEmail = HAS_EMAIL_RE.test(String(lead.email || '').trim());
  const canGo = hasEmail && step < total;

  switch (lead.followupStatus) {
    case 'active': {
      if (!s.enabled) return { tone: 'muted', text: 'Paused — automatic follow-ups are switched off in Settings.', action: 'stop' };
      if (isHeld(lead, s)) return { tone: 'warn', text: 'Held — test mode is on, so only leads named TEST… are emailed.', action: 'stop' };
      const when = lead.followupNextAt && new Date(lead.followupNextAt) > now ? `~${fmtWhen(lead.followupNextAt)}` : 'at the next check';
      const text = step === 0 ? `Follow-up 1 of ${total} goes out ${when}.` : `Follow-up ${step} of ${total} sent · next ${when}.`;
      return { tone: 'info', text, action: 'stop' };
    }
    case 'replied':
      return { tone: 'ok', text: 'Customer replied — check the inbox and follow up personally.', action: canGo ? 'resume' : null };
    case 'no_email':
      return { tone: 'muted', text: hasEmail ? 'Email updated — resume to continue follow-ups.' : 'No email on file — add one to enable follow-ups.', action: canGo ? 'resume' : null };
    case 'stopped':
      return { tone: 'muted', text: lead.followupStopReason === 'manual' ? 'Follow-ups stopped.' : 'Follow-ups stopped (status changed).', action: canGo ? 'resume' : null };
    case 'error':
      return { tone: 'warn', text: 'Sending failed 3 times — check the email address.', action: canGo ? 'resume' : null };
    case 'completed':
      return { tone: 'muted', text: closed ? `Closed automatically — no response after ${total} follow-ups.` : 'All follow-ups sent.', action: null };
    default:
      if (!hasEmail) return { tone: 'muted', text: 'No email on file — add one to enable follow-ups.', action: null };
      return {
        tone: 'muted',
        text: s.enabled ? 'Not in a follow-up sequence (quoted before follow-ups were on).' : 'Automatic follow-ups are off — turn them on in Settings.',
        action: 'start',
      };
  }
}

// Fields + local state for Start/Resume. Never enrolled -> step 0. Resume keeps the
// step. quote_sent_at is the reply-check baseline: stamp it when missing, and reset it
// when resuming after a reply (otherwise the same reply is found again).
export function followupStartPatch(lead, nowIso) {
  const step = lead.followupStatus ? (lead.followupStep || 0) : 0;
  const quoteSentAt = (!lead.quoteSentAt || lead.followupStatus === 'replied') ? nowIso : lead.quoteSentAt;
  return {
    fields: {
      'Follow-up Status': 'active', 'Follow-up Step': step, 'Follow-up Next At': nowIso,
      'Follow-up Fail Count': 0, 'Follow-up Stop Reason': null, 'Quote Sent At': quoteSentAt,
    },
    local: { followupStatus: 'active', followupStep: step, followupNextAt: nowIso, followupStopReason: null, quoteSentAt },
  };
}
