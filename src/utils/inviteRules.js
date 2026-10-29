// Booking-form invite rules (frontend). The email check follows the sender's
// cleanEmail rule (whatsapp-service/followup-core.js).

// Unanchored, like the sender's cleanEmail ("Jane <jane@x.com>" is sendable).
const HAS_EMAIL_RE = /[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+/;

// The Job Time field's hint. The time is optional — without one the sender
// (calendar-core.js buildEvent) makes the invitation an all-day event.
export function timeHint(email, settings) {
  if (!settings?.enabled) return '';
  return HAS_EMAIL_RE.test(String(email || '').trim())
    ? "Without a time, the client's invitation is for the whole day"
    : 'No email on file — no calendar invitation will be sent';
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
