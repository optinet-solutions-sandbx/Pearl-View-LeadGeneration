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
  recordEvent: sb.recordBookingEvent,
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
    // events.list, not calendarList.get: the token only carries calendar.events,
    // which can't read calendarList (that call always says "Insufficient Permission").
    await calendarApi().events.list({ calendarId: 'primary', maxResults: 1 }, GOOGLE_OPTS);
  },
};

const httpStatus = err => err?.code ?? err?.response?.status;
const isGone = err => [404, 410].includes(Number(httpStatus(err)));
const isConflict = err => Number(httpStatus(err)) === 409;

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

  const bookings = await deps.fetchDue({ nowIso: now.toISOString(), testOnly: !!settings.test_mode, limit: BATCH });
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
        let eventId = b.gcal_event_id;
        let inserted = false; // a NEW Google event exists (insert / 409-adopt / recreate)
        try {
          if (plan.type === 'cancel') {
            try { await deps.deleteEvent(eventId); } catch (err) { if (!isGone(err)) throw err; }
          } else {
            const body = core.buildEvent(b, { ...ctx, attendee: plan.attendee });
            const newId = core.eventIdFor(b.id, b.gcal_rev);
            // Insert with a deterministic id; 409 = an earlier (crashed) run already created it → adopt it.
            const insertOrAdopt = async () => {
              try {
                return await deps.insertEvent({ ...body, id: newId });
              } catch (err) {
                if (!isConflict(err)) throw err;
                await deps.patchEvent(newId, body);
                return newId;
              }
            };
            if (plan.type === 'update') {
              try {
                await deps.patchEvent(eventId, body);
              } catch (err) {
                if (!isGone(err)) throw err;
                eventId = await insertOrAdopt(); // event deleted on Google's side → recreate
                inserted = true;
              }
            } else {
              eventId = await insertOrAdopt();
              inserted = true;
            }
          }
        } catch (err) {
          const msg = String(err.message || err).slice(0, 500);
          console.error(`[ALERT] 🚨 [calendar-sync] ${plan.type} failed for ${b.id}: ${msg}`);
          out.errors++;
          await deps.finish(b.id, b.gcal_rev, core.afterFailure(b, now));
          continue;
        }
        if (inserted) {
          // Persist the new event id NOW, by booking id only: if the office edits the
          // booking before finish (rev-guarded) lands, the next run must update THIS
          // event — not insert a second one, leaving this one where no cancel reaches it.
          try {
            await deps.recordEvent(b.id, eventId, plan.attendee);
          } catch (err) {
            // No finish: the lease expires and the retry re-inserts the same
            // deterministic id → 409 → adopts this event.
            console.error(`[ALERT] 🚨 [calendar-sync] event ${eventId} created but not recorded for ${b.id}: ${String(err.message || err).slice(0, 500)}`);
            out.errors++;
            continue;
          }
        }
        patch = core.afterSuccess(plan.type, now, eventId, plan.attendee);
        if (plan.type === 'create') out.created++;
        else if (plan.type === 'update') out.updated++;
        else out.cancelled++;
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

module.exports = { runCalendarSync, realDeps };
