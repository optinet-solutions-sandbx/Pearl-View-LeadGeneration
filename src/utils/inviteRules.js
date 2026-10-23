// Booking-form invite rules (frontend). The time parsing MUST accept exactly what
// whatsapp-service/calendar-core.js parseJobTime accepts, and the email check the
// sender's cleanEmail rule — execution/test_invite_rules.mjs enforces the time parity.

export const TIME_REQUIRED_MSG = 'Add a time — the client gets a calendar invitation.';

// Unanchored, like the sender's cleanEmail ("Jane <jane@x.com>" is sendable).
const HAS_EMAIL_RE = /[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+/;

export function isParseableTime(str) {
  const m = String(str == null ? '' : str).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  if (parseInt(m[2], 10) > 59) return false;
  return m[3] ? h >= 1 && h <= 12 : h <= 23;
}

export function timeRequired(email, jobTime) {
  if (!HAS_EMAIL_RE.test(String(email || '').trim())) return '';
  return isParseableTime(jobTime) ? '' : TIME_REQUIRED_MSG;
}

const LABELS = {
  sent:        { text: '📅 Invite sent', tone: 'ok' },
  pending:     { text: 'Invite queued', tone: 'muted' },
  sending:     { text: 'Invite queued', tone: 'muted' },
  no_email:    { text: 'No email', tone: 'muted' },
  needs_time:  { text: 'Needs a time', tone: 'warn' },
  failed:      { text: 'Invite failed — check the email', tone: 'bad' },
  emailed_ics: { text: 'Invite emailed', tone: 'ok' },
};

export function inviteStatusLabel(booking, settings) {
  if (!settings || !booking) return null;
  const l = LABELS[booking.inviteStatus];
  return l ? { ...l } : null;
}
