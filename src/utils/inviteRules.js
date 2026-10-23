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

// Only while invitations are switched on — otherwise nothing will be sent.
export function timeRequired(email, jobTime, settings) {
  if (!settings?.enabled) return '';
  if (!HAS_EMAIL_RE.test(String(email || '').trim())) return '';
  return isParseableTime(jobTime) ? '' : TIME_REQUIRED_MSG;
}

const LABELS = {
  sent:        { text: '📅 Invite sent', tone: 'ok' },
  pending:     { text: 'Invite queued', tone: 'muted' },
  sending:     { text: 'Invite queued', tone: 'muted' },
  no_email:    { text: 'No email', tone: 'muted' },
  needs_time:  { text: 'Needs a time', tone: 'warn' },
  failed:      { text: 'Invite failed', tone: 'bad' },
  emailed_ics: { text: "Invite emailed (can't be moved automatically)", tone: 'ok' },
};

// These say an invite is still to come — only true for a Scheduled booking dated today or later.
const UPCOMING_ONLY = new Set(['pending', 'sending', 'needs_time', 'no_email']);
const localYmd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function inviteStatusLabel(booking, settings) {
  if (!settings || !booking) return null;
  const l = LABELS[booking.inviteStatus];
  if (!l) return null;
  if (UPCOMING_ONLY.has(booking.inviteStatus)
      && (booking.bookingStatus !== 'Scheduled' || String(booking.date || '').slice(0, 10) < localYmd(new Date()))) return null;
  return { ...l };
}

// The edit form's fields that actually changed versus `initial` (trimmed; '' equals
// null/undefined), as trimmed values. An untouched field is never written, so a
// '' vs NULL difference can't re-flag the booking and re-send the invitation.
export function changedFields(form, initial) {
  const s = v => (v == null ? '' : String(v).trim());
  const out = {};
  for (const [k, v] of Object.entries(form || {})) if (s(v) !== s(initial?.[k])) out[k] = s(v);
  return out;
}
