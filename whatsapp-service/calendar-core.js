/**
 * Pure (no I/O) decisions for syncing a booking to a Google Calendar event.
 * The sync job (calendar.js) does the I/O; everything testable lives here.
 */
const { cleanEmail, isTestLead } = require('./followup-core');

const EVENT_MINUTES = 120;
const BACKOFF_MINUTES = [15, 60, 240];
const MAX_FAILS = 5;

const pad = n => String(n).padStart(2, '0');

// '9:00 AM' | '2:30pm' | '14:30' -> 'HH:MM', or null when unusable.
function parseJobTime(str) {
  const m = String(str == null ? '' : str).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const mer = m[3] && m[3].toLowerCase();
  if (min > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) return null;
  return `${pad(h)}:${pad(min)}`;
}

function planSync(booking, settings, todayYmd) {
  const b = booking || {};
  const s = settings || {};
  const hasEvent = !!b.gcal_event_id;

  if (b.booking_status === 'Completed') return { type: 'noop' };
  if (b.booking_status === 'Cancelled') return { type: hasEvent ? 'cancel' : 'noop' };

  const realEmail = cleanEmail(b.client_email);
  if (!realEmail) return { type: hasEvent ? 'cancel' : 'no_email' };

  let attendee = realEmail;
  if (s.test_mode) {
    const testEmail = cleanEmail(s.test_email);
    if (isTestLead(b.client_name) && testEmail) attendee = testEmail;
    else if (hasEvent) attendee = b.gcal_attendee || realEmail; // keep an existing event in step
    else return { type: 'hold' };
  }

  if (!parseJobTime(b.job_time)) return { type: 'needs_time' };
  if (String(b.date || '') < todayYmd) return { type: 'past' };
  if (!s.enabled && !hasEvent) return { type: 'noop' };
  return { type: hasEvent ? 'update' : 'create', attendee };
}

// End = start + EVENT_MINUTES on a wall-clock string; no Date/time-zone conversion.
function addMinutes(ymd, hhmm, minutes) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi + minutes));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

function buildEvent(booking, { tz, brandShort, businessEmail, businessPhone, attendee }) {
  const service = booking.job_service || 'Window Cleaning';
  const time = parseJobTime(booking.job_time);
  return {
    summary: `${service} — ${brandShort}`,
    location: booking.service_address || booking.city || '',
    description: `Your window clean with ${brandShort}.\nService: ${service}\nNeed to change it? Reply to this invitation or contact us on ${businessPhone} / ${businessEmail}.`,
    start: { dateTime: `${booking.date}T${time}:00`, timeZone: tz },
    end: { dateTime: addMinutes(booking.date, time, EVENT_MINUTES), timeZone: tz },
    attendees: [{ email: attendee, displayName: booking.client_name }],
    reminders: { useDefault: true },
  };
}

function afterSuccess(type, now, eventId, attendee) {
  const cancelled = type === 'cancel';
  return {
    gcal_event_id: cancelled ? null : eventId,
    gcal_status: cancelled ? 'cancelled' : 'sent',
    gcal_attendee: cancelled ? null : attendee,
    gcal_sync_needed: false,
    gcal_fail_count: 0,
    gcal_next_at: null,
    gcal_synced_at: now.toISOString(),
  };
}

function afterSkip(type) {
  const patch = {};
  if (type === 'no_email') patch.gcal_status = 'no_email';
  if (type === 'needs_time') patch.gcal_status = 'needs_time';
  return { ...patch, gcal_sync_needed: false, gcal_next_at: null };
}

function afterFailure(booking, now) {
  const count = (booking.gcal_fail_count || 0) + 1;
  if (count >= MAX_FAILS) {
    return { gcal_fail_count: count, gcal_status: 'failed', gcal_sync_needed: false, gcal_next_at: null };
  }
  const mins = BACKOFF_MINUTES[Math.min(count - 1, BACKOFF_MINUTES.length - 1)];
  return { gcal_fail_count: count, gcal_next_at: new Date(now.getTime() + mins * 60000).toISOString() };
}

module.exports = {
  EVENT_MINUTES, BACKOFF_MINUTES, MAX_FAILS,
  parseJobTime, planSync, buildEvent, afterSuccess, afterSkip, afterFailure,
};
