/**
 * calendar-sync.js — turns flagged bookings into Google Calendar events. Cloud
 * Scheduler calls POST /run-calendar-sync → runCalendarSync(). Every decision
 * comes from calendar-core.js (pure, unit-tested); this file only does I/O, and
 * all I/O goes through `deps` so calendar-sync.test.js can run it against fakes.
 */
const { google } = require('googleapis');
const sb = require('./sb');
const core = require('./calendar-core');
const { TZ, BRAND_SHORT, BUSINESS } = require('./config');

const BATCH = 25;     // bookings per run
const LEASE_MIN = 10; // claim lease — a crashed run frees its bookings after this
const GOOGLE_OPTS = { timeout: 30000 };

function calendarApi() {
  // Lazy require: booking.js is a big module; load only when we talk to Google.
  const { oauthClient } = require('./booking');
  return google.calendar({ version: 'v3', auth: oauthClient() });
}

const realDeps = {
  getSettings: sb.getCalendarInviteSettings,
  fetchDue: sb.fetchBookingsToSync,
  claim: sb.claimBookingSync,
  finish: sb.finishBookingSync,
  async insertEvent(requestBody) {
    const r = await calendarApi().events.insert({ calendarId: 'primary', sendUpdates: 'all', requestBody }, GOOGLE_OPTS);
    return r.data.id;
  },
  async patchEvent(eventId, requestBody) {
    await calendarApi().events.patch({ calendarId: 'primary', eventId, sendUpdates: 'all', requestBody }, GOOGLE_OPTS);
  },
  async deleteEvent(eventId) {
    await calendarApi().events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' }, GOOGLE_OPTS);
  },
  async probe() {
    await calendarApi().calendarList.get({ calendarId: 'primary' }, GOOGLE_OPTS);
  },
};

const httpStatus = err => err?.code ?? err?.response?.status;
const isGone = err => [404, 410].includes(Number(httpStatus(err)));

// Current date in the business time zone as 'YYYY-MM-DD'.
function todayInTz(now, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function runCalendarSync({ dry = false, probe = false, now = new Date(), deps = realDeps } = {}) {
  if (deps === realDeps && !sb.USE_SUPABASE) return { skipped: 'supabase_off' };

  if (probe) {
    try {
      await deps.probe();
      return { probe: 'ok' };
    } catch (err) {
      return { probe: String(err.message || err) };
    }
  }

  const settings = await deps.getSettings();
  if (!settings) return { skipped: 'not_set_up' };

  const bookings = await deps.fetchDue({ nowIso: now.toISOString(), limit: BATCH });
  const today = todayInTz(now, TZ);
  const out = {
    dry, enabled: !!settings.enabled, testMode: !!settings.test_mode, due: bookings.length,
    created: 0, updated: 0, cancelled: 0, held: 0, skipped: 0, requeued: 0, errors: 0, actions: [],
  };
  const ctx = { tz: TZ, brandShort: BRAND_SHORT, businessEmail: BUSINESS.email, businessPhone: BUSINESS.phone };

  for (const b of bookings) {
    const plan = core.planSync(b, settings, today);
    out.actions.push({ id: b.id, name: b.client_name, type: plan.type, ...(plan.attendee ? { attendee: plan.attendee } : {}) });
    if (dry) continue;
    if (plan.type === 'hold') { out.held++; continue; } // writes nothing, claims nothing

    try {
      if (!(await deps.claim(b.id, b.gcal_rev, now, LEASE_MIN))) continue;

      let patch;
      if (plan.type === 'create' || plan.type === 'update' || plan.type === 'cancel') {
        try {
          let eventId = b.gcal_event_id;
          if (plan.type === 'cancel') {
            try { await deps.deleteEvent(eventId); } catch (err) { if (!isGone(err)) throw err; }
          } else {
            const body = core.buildEvent(b, { ...ctx, attendee: plan.attendee });
            if (plan.type === 'update') {
              try {
                await deps.patchEvent(eventId, body);
              } catch (err) {
                if (!isGone(err)) throw err;
                eventId = await deps.insertEvent(body); // event deleted on Google's side → recreate
              }
            } else {
              eventId = await deps.insertEvent(body);
            }
          }
          patch = core.afterSuccess(plan.type, now, eventId, plan.attendee);
          if (plan.type === 'create') out.created++;
          else if (plan.type === 'update') out.updated++;
          else out.cancelled++;
        } catch (err) {
          const msg = String(err.message || err).slice(0, 500);
          console.error(`[ALERT] 🚨 [calendar-sync] ${plan.type} failed for ${b.id}: ${msg}`);
          out.errors++;
          await deps.finish(b.id, b.gcal_rev, core.afterFailure(b, now));
          continue;
        }
      } else {
        // noop / past / no_email / needs_time — nothing to send; clear the flag.
        patch = core.afterSkip(plan.type);
        out.skipped++;
      }

      if (!(await deps.finish(b.id, b.gcal_rev, patch))) {
        // The office edited the booking mid-sync; it stays flagged and the next run re-syncs it.
        out.requeued++;
      } else if (plan.type !== 'noop' && plan.type !== 'past') {
        console.log(`[calendar-sync] ${plan.type} ${b.client_name} (${b.id})`);
      }
    } catch (err) {
      // e.g. DB outage — the lease expires and a later run retries.
      console.error(`[ALERT] 🚨 [calendar-sync] booking ${b.id} failed: ${err.message}`);
      out.errors++;
    }
  }
  return out;
}

module.exports = { runCalendarSync };
