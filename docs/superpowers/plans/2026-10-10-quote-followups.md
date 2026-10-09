# Quote Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically email a 3-step follow-up to leads stuck in Quote Sent, stop on status change / customer reply / manual stop, auto-Refuse after the final email, and let the owner configure everything (with a safe test mode) from a new Settings page.

**Architecture:** A Postgres trigger enrolls leads as they enter Quote Sent (every write path). A Cloud Run endpoint `POST /run-followups` (Cloud Scheduler, every 15 min) picks due leads, makes every decision through a pure, unit-tested core module, and does I/O (Supabase service_role, Gmail API, Green-API) through injectable deps. The React dashboard edits a single `followup_settings` row and shows per-lead follow-up state with Stop/Start controls.

**Tech Stack:** Node 20 CommonJS (`whatsapp-service`, express/axios/googleapis, `node:test`), Supabase Postgres + PostgREST + RLS, React 18 + Vite (ESM, inline styles), Gmail API, Green-API, Cloud Run + Cloud Scheduler.

**Spec:** `docs/superpowers/specs/2026-10-09-quote-followups-design.md`

## Global Constraints

- No new npm dependencies. Backend tests: `node:test` + `node:assert/strict`, run with `node --test <file>` from `whatsapp-service/`. Frontend tests: plain `node` + `node:assert/strict` scripts in `execution/` (pattern: `execution/test_reconcile.mjs`).
- `whatsapp-service` is CommonJS on Node 20 (`FROM node:20-slim`). Repo root is ESM (`"type": "module"`); React components use inline styles + CSS vars (`var(--gray-200)`, `var(--primary)`, `var(--gray-500)`…).
- Feature ships **OFF**: `followup_settings.enabled = false`, `test_mode = true`.
- Exact values: lead statuses `'Quote Sent'`, `'Refused'`; refusal code `no_response` (label "No Response to Follow-ups"); header `X-PearlView-Kind: followup`; follow-up statuses `active | stopped | replied | completed | no_email | error`; stop reasons `status_changed | manual | replied | send_failed`.
- Defaults: delays **48 / 72 / 120 h**; send window **8–18** in business TZ (`config.TZ`); batch **25**; claim lease **10 min**; **3** consecutive failures → `error`; failure retry **+1 h**.
- Scheduler: `*/15 * * * *`, TZ `Australia/Sydney`, `POST /run-followups`, header `x-cron-secret`.
- Supabase NSW project `zagmrxxmhyprhnhucqpo`. DDL runs **only** in the Supabase SQL Editor — the user runs it.
- **Never push or deploy the frontend without the user's explicit "push it".** Prod frontend deploys via `git push origin main` (auto-deploy). Do not use `vercel --prod`.
- Cloud Run deploy needs the user's interactive `gcloud auth login` first; use `--update-env-vars`, never `--set-env-vars`.
- UI work: Playwright screenshots into `.tmp/screenshots/`, review, fix, delete all screenshots when done.
- Commit only the files the task touches (the working tree has unrelated changes — never `git add -A`). End every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- After each task, tick the matching PMS subtask (task `cmv15gvlc002n04l53rm9rcr2`) from the repo root:
  ```bash
  node --env-file=.env -e "const T=process.env.PMS_BASE_URL+'/api/tasks/cmv15gvlc002n04l53rm9rcr2',H={Authorization:'Bearer '+process.env.PMS_API_TOKEN,'Content-Type':'application/json'};fetch(T,{headers:H}).then(r=>r.json()).then(d=>{const s=(d.subtasks||[]).find(x=>x.title.startsWith(process.argv[1]));if(!s)return console.log('no subtask');return fetch(T+'/subtasks/'+s.id,{method:'PATCH',headers:H,body:JSON.stringify({done:true})}).then(r=>console.log(r.status,s.title))})" "<subtask title prefix>"
  ```

## Review Focus

1. **Hostile/messy customer email strings** (`"Jane <jane@x.com>"`, zero-width chars, `jane@x.com\r\nBcc: evil@y.com`) → recipient is the bare address and no extra header can be injected. Pinned in Task 1 (`cleanEmail`, `buildFollowupMime` tests).
2. **HTML-special characters in templates or names** (`<b>`, `&`, `"`) → the HTML part is escaped, the plain-text part is untouched. Pinned in Task 1 (`htmlFromText` test).
3. **Test mode ON with a blank/invalid test email** → the lead is held; it is never emailed to the customer. Pinned in Task 2 (`planAction` no_test_email test).
4. **Settings edited mid-sequence** (delay `null`/`"abc"`/negative, step disabled, empty subject, `steps` null) → engine falls back to defaults or skips; never crashes, never sends an empty email; trigger never blocks a lead save. Pinned in Task 2 (`delayHours`, skip/complete tests) and Task 5 (safe cast in trigger).
5. **Owner changes the lead's status while a run is mid-flight** → the engine's post-send update must not overwrite the owner's status with Refused. Pinned in Task 5 (verification script step 2: guarded update on a Booked lead returns false, status stays Booked).

---

### Task 1: Pure email + template helpers (`followup-core.js`, part 1)

**Files:**
- Create: `whatsapp-service/followup-core.js`
- Test: `whatsapp-service/followup-core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces (CommonJS exports, all pure):
  - `FOLLOWUP_HEADER = 'X-PearlView-Kind'`, `FOLLOWUP_KIND = 'followup'`, `REFUSAL_CODE = 'no_response'`
  - `cleanEmail(raw: any) → string` ('' when none)
  - `firstName(clientName: any) → string` ('there' fallback)
  - `formatMoney(n: any) → string` ('' when not > 0)
  - `renderTemplate(tpl: any, ctx: object) → string`
  - `buildContext(lead: {client_name, quote_amount}, settings: {sender_name, company_name}, fallbackCompany: string) → {first_name, client_name, company, sender, quote_amount}`
  - `htmlFromText(text: string) → string`
  - `b64url(str: string) → string`
  - `buildFollowupMime({fromName, fromEmail, to, subject, text, html}) → string` (CRLF MIME)
  - `isFollowupMessage(headers: Array<{name, value}>) → boolean`
  - `replyAlertText(lead: {client_name, email}, inbox: string, dashboardUrl: string) → string`

- [ ] **Step 1: Write the failing tests**

Create `whatsapp-service/followup-core.test.js`:

```js
// Unit tests for the pure follow-up logic. Run: node --test followup-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./followup-core');

test('cleanEmail extracts a bare address from messy input', () => {
  assert.equal(core.cleanEmail('  jane@x.com  '), 'jane@x.com');
  assert.equal(core.cleanEmail('Jane Doe <jane@x.com>'), 'jane@x.com');
  assert.equal(core.cleanEmail('jane\u200B@x.com'), 'jane@x.com');
  assert.equal(core.cleanEmail('jane@x.com\r\nBcc: evil@y.com'), 'jane@x.com');
  assert.equal(core.cleanEmail(''), '');
  assert.equal(core.cleanEmail(null), '');
  assert.equal(core.cleanEmail('not an email'), '');
});

test('firstName falls back to "there" for placeholder names', () => {
  assert.equal(core.firstName('Jane Smith'), 'Jane');
  assert.equal(core.firstName('  jane  '), 'jane');
  for (const n of ['', null, 'Unknown', 'Unknown Caller', 'unknown caller', '—', '-']) {
    assert.equal(core.firstName(n), 'there', String(n));
  }
});

test('formatMoney', () => {
  assert.equal(core.formatMoney(350), '$350');
  assert.equal(core.formatMoney(1234.5), '$1,234.50');
  assert.equal(core.formatMoney('980'), '$980');
  assert.equal(core.formatMoney(0), '');
  assert.equal(core.formatMoney(null), '');
});

test('renderTemplate fills known placeholders and leaves unknown ones', () => {
  const ctx = { first_name: 'Jane', company: 'Pearlview', sender: 'Brad', quote_amount: '$350', client_name: 'Jane Smith' };
  assert.equal(
    core.renderTemplate('Hi {first_name}, {company} quoted {quote_amount}. {sender} {oops}', ctx),
    'Hi Jane, Pearlview quoted $350. Brad {oops}',
  );
  assert.equal(core.renderTemplate(null, ctx), '');
});

test('buildContext: settings company/signature win, fallbacks fill blanks', () => {
  const lead = { client_name: 'Jane Smith', quote_amount: 350 };
  assert.deepEqual(
    core.buildContext(lead, { sender_name: 'Brad @ Pearlview', company_name: 'Pearlview Window Cleaning' }, 'Fallback Co'),
    { first_name: 'Jane', client_name: 'Jane Smith', company: 'Pearlview Window Cleaning', sender: 'Brad @ Pearlview', quote_amount: '$350' },
  );
  const blank = core.buildContext(lead, { sender_name: ' ', company_name: '' }, 'Fallback Co');
  assert.equal(blank.company, 'Fallback Co');
  assert.equal(blank.sender, 'Fallback Co');
});

test('htmlFromText escapes HTML and keeps paragraphs', () => {
  const html = core.htmlFromText('Hi <b>Jane</b> & "co",\n\nLine one\nLine two');
  assert.match(html, /Hi &lt;b&gt;Jane&lt;\/b&gt; &amp; &quot;co&quot;,/);
  assert.match(html, /Line one<br>Line two/);
  assert.equal((html.match(/<p /g) || []).length, 2);
  assert.doesNotMatch(html, /<b>/);
});

test('b64url is URL-safe and unpadded', () => {
  assert.equal(core.b64url('>>>???'), 'Pj4-Pz8_');
  assert.doesNotMatch(core.b64url('any string at all!'), /[+/=]/);
});

test('buildFollowupMime tags the email and blocks header injection', () => {
  const mime = core.buildFollowupMime({
    fromName: 'Pearlview Window Cleaning', fromEmail: 'service@pearlview.com.au',
    to: 'jane@x.com\r\nBcc: evil@y.com', subject: 'Hi\r\nBcc: evil@y.com', text: 'Hello', html: '<p>Hello</p>',
  });
  assert.match(mime, /^X-PearlView-Kind: followup$/m);
  assert.match(mime, /^To: jane@x\.com$/m);
  assert.match(mime, /^Reply-To: Pearlview Window Cleaning <service@pearlview\.com\.au>$/m);
  assert.doesNotMatch(mime, /^Bcc:/im);
  assert.match(mime, /Content-Type: multipart\/alternative/);
});

test('buildFollowupMime encodes non-ASCII subjects', () => {
  const mime = core.buildFollowupMime({ fromName: 'P', fromEmail: 'a@b.co', to: 'c@d.co', subject: 'Quote — check-in', text: 't', html: 'h' });
  assert.match(mime, /^Subject: =\?UTF-8\?B\?.+\?=$/m);
});

test('isFollowupMessage detects our header (case-insensitive)', () => {
  assert.equal(core.isFollowupMessage([{ name: 'x-pearlview-kind', value: 'FollowUp ' }]), true);
  assert.equal(core.isFollowupMessage([{ name: 'Subject', value: 'followup' }]), false);
  assert.equal(core.isFollowupMessage(undefined), false);
});

test('replyAlertText names the customer, inbox and dashboard', () => {
  const t = core.replyAlertText({ client_name: 'Jane Smith', email: 'jane@x.com' }, 'service@pearlview.com.au', 'https://dash');
  assert.match(t, /Jane Smith \(jane@x\.com\)/);
  assert.match(t, /service@pearlview\.com\.au/);
  assert.match(t, /https:\/\/dash/);
  assert.match(core.replyAlertText({ client_name: '', email: '' }, 'i', 'u'), /A customer \(no email\)/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd whatsapp-service && node --test followup-core.test.js`
Expected: FAIL — `Cannot find module './followup-core'`.

- [ ] **Step 3: Implement**

Create `whatsapp-service/followup-core.js`:

```js
/**
 * followup-core.js — pure logic for the quote follow-up sequence (no I/O).
 * Deterministic + unit-tested (followup-core.test.js). followup.js does the
 * DB / Gmail / WhatsApp side effects. The frontend mirrors firstName /
 * formatMoney / renderTemplate / isTestLead in src/utils/followupTemplate.js —
 * execution/test_followup_template.mjs keeps the two in sync.
 */

const FOLLOWUP_HEADER = 'X-PearlView-Kind';
const FOLLOWUP_KIND = 'followup';
const REFUSAL_CODE = 'no_response';

// ─── Email + template helpers ────────────────────────────────────────────────
const INVISIBLE = [0x200B, 0x200C, 0x200D, 0xFEFF, 0xA0];
const EMAIL_TOKEN = /[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+/;
const NO_NAME = /^(unknown( caller)?|—|-|n\/a)?$/i;

// Strip invisible chars, then take the first email-shaped token. Anything after
// whitespace (incl. CR/LF) is dropped, so a stored value can't inject headers.
function cleanEmail(raw) {
  const zapped = [...String(raw || '')].filter(c => !INVISIBLE.includes(c.codePointAt(0))).join('');
  const m = zapped.match(EMAIL_TOKEN);
  return m ? m[0] : '';
}

function firstName(clientName) {
  const n = String(clientName || '').trim();
  return NO_NAME.test(n) ? 'there' : n.split(/\s+/)[0];
}

function formatMoney(n) {
  const v = Number(n);
  if (!(v > 0)) return '';
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function renderTemplate(tpl, ctx) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, key) =>
    (Object.prototype.hasOwnProperty.call(ctx, key) ? String(ctx[key] ?? '') : m));
}

function buildContext(lead, settings, fallbackCompany) {
  const company = String(settings.company_name || '').trim() || fallbackCompany;
  return {
    first_name: firstName(lead.client_name),
    client_name: String(lead.client_name || '').trim(),
    company,
    sender: String(settings.sender_name || '').trim() || company,
    quote_amount: formatMoney(lead.quote_amount),
  };
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function htmlFromText(text) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const body = paras.map(p => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return '<!doctype html><html><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;'
    + `font-size:15px;line-height:1.55;color:#1f2937">${body}</body></html>`;
}

function b64url(str) {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// RFC 2047 for non-ASCII; CR/LF collapsed first so a value can't start a new header.
function encodeHeader(str) {
  const s = String(str || '').replace(/[\r\n]+/g, ' ');
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`;
}

function buildFollowupMime({ fromName, fromEmail, to, subject, text, html }) {
  const alt = 'pv_followup_alt_0001';
  const from = `${encodeHeader(fromName)} <${cleanEmail(fromEmail)}>`;
  return [
    `From: ${from}`,
    `To: ${cleanEmail(to)}`,
    `Reply-To: ${from}`,
    `Subject: ${encodeHeader(subject)}`,
    `${FOLLOWUP_HEADER}: ${FOLLOWUP_KIND}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(text || ''), 'utf-8').toString('base64'),
    '',
    `--${alt}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(String(html || ''), 'utf-8').toString('base64'),
    '',
    `--${alt}--`,
  ].join('\r\n');
}

// Used by email-extractor.js so our own follow-ups are never ingested as leads.
function isFollowupMessage(headers) {
  return (headers || []).some(h =>
    String(h.name || '').toLowerCase() === FOLLOWUP_HEADER.toLowerCase()
    && String(h.value || '').trim().toLowerCase() === FOLLOWUP_KIND);
}

function replyAlertText(lead, inbox, dashboardUrl) {
  const who = String(lead.client_name || '').trim() || 'A customer';
  return [
    '*💬 Quote follow-up reply*',
    '',
    `${who} (${cleanEmail(lead.email) || 'no email'}) replied after a quote follow-up.`,
    `Check the ${inbox} inbox and reach out personally — automatic follow-ups for this lead have stopped.`,
    '',
    '👉 Open in app:',
    dashboardUrl,
  ].join('\n');
}

module.exports = {
  FOLLOWUP_HEADER, FOLLOWUP_KIND, REFUSAL_CODE,
  cleanEmail, firstName, formatMoney, renderTemplate, buildContext,
  htmlFromText, b64url, buildFollowupMime, isFollowupMessage, replyAlertText,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd whatsapp-service && node --test followup-core.test.js`
Expected: PASS — 11 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add whatsapp-service/followup-core.js whatsapp-service/followup-core.test.js
git commit -m "feat(followups): pure email + template helpers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Pure scheduling decisions (`followup-core.js`, part 2)

**Files:**
- Modify: `whatsapp-service/followup-core.js` (add section + exports)
- Test: `whatsapp-service/followup-core.test.js` (append)

**Interfaces:**
- Consumes: Task 1 helpers (`cleanEmail`, `buildContext`, `renderTemplate`, `REFUSAL_CODE`).
- Produces:
  - `DEFAULT_DELAY_HOURS = [48, 72, 120]`, `MAX_FAILS = 3`
  - `localHour(now: Date, tz: string) → number`
  - `inSendWindow(now: Date, tz: string, startHour, endHour) → boolean` (start inclusive, end exclusive; invalid → 8/18)
  - `isTestLead(name: any) → boolean` (`/^\s*test\b/i`)
  - `delayHours(steps: array, i: number) → number`
  - `planAction(lead, settings, fallbackCompany) →`
    `{type:'complete'}` | `{type:'hold', reason:'test_mode'|'no_test_email'}` | `{type:'skip', stepIndex}` | `{type:'no_email'}` |
    `{type:'send', stepIndex, to, realTo, test, subject, text}`
    — `lead` is a raw `leads` row: `{id, client_name, email, quote_amount, quote_sent_at, followup_step, followup_fail_count}`.
  - `afterStep(settings, stepIndex, now: Date, {sent: boolean}) → object` (snake_case column patch)
  - `afterFailure(lead, now: Date) → object` (snake_case column patch)

- [ ] **Step 1: Append the failing tests**

Append to `whatsapp-service/followup-core.test.js`:

```js
// ─── Scheduling decisions ────────────────────────────────────────────────────
const SETTINGS = () => ({
  enabled: true, test_mode: false, test_email: 'owner@test.com', sender_name: 'Pearlview',
  window_start_hour: 8, window_end_hour: 18,
  steps: [
    { enabled: true, delay_hours: 48, subject: 'S1 {first_name}', body: 'B1 {first_name} {quote_amount}' },
    { enabled: true, delay_hours: 72, subject: 'S2', body: 'B2' },
    { enabled: true, delay_hours: 120, subject: 'S3 {company}', body: 'B3' },
  ],
});
const LEAD = (o = {}) => ({ id: 'L1', client_name: 'Jane Smith', email: 'jane@x.com', quote_amount: 350, followup_step: 0, followup_fail_count: 0, ...o });
const NOW = new Date('2026-10-12T00:00:00Z'); // 11:00 Sydney (AEDT, UTC+11)

test('inSendWindow uses business-local hours incl. DST', () => {
  assert.equal(core.inSendWindow(new Date('2026-10-12T00:00:00Z'), 'Australia/Sydney', 8, 18), true);   // 11:00 AEDT
  assert.equal(core.inSendWindow(new Date('2026-10-11T20:59:00Z'), 'Australia/Sydney', 8, 18), false);  // 07:59 AEDT
  assert.equal(core.inSendWindow(new Date('2026-10-12T07:00:00Z'), 'Australia/Sydney', 8, 18), false);  // 18:00 — end exclusive
  assert.equal(core.inSendWindow(new Date('2026-06-30T22:30:00Z'), 'Australia/Sydney', 8, 18), true);   // 08:30 AEST (winter)
  assert.equal(core.inSendWindow(new Date('2026-10-12T00:30:00Z'), 'Australia/Perth', 8, 18), true);    // 08:30 AWST
  assert.equal(core.inSendWindow(new Date('2026-10-12T00:00:00Z'), 'Australia/Sydney', null, undefined), true); // defaults 8–18
});

test('isTestLead matches a leading TEST word only', () => {
  assert.equal(core.isTestLead('TEST Full Run'), true);
  assert.equal(core.isTestLead('test-reply'), true);
  assert.equal(core.isTestLead('  Test Booked'), true);
  assert.equal(core.isTestLead('Testa Smith'), false);
  assert.equal(core.isTestLead('Jane TEST'), false);
  assert.equal(core.isTestLead(null), false);
});

test('delayHours falls back to defaults for missing/invalid values', () => {
  const steps = [{ delay_hours: 24 }, { delay_hours: 'abc' }, { delay_hours: null }];
  assert.equal(core.delayHours(steps, 0), 24);
  assert.equal(core.delayHours(steps, 1), 72);
  assert.equal(core.delayHours(steps, 2), 120);
  assert.equal(core.delayHours([{ delay_hours: -5 }], 0), 48);
  assert.equal(core.delayHours([{ delay_hours: '6' }], 0), 6);
});

test('planAction: live mode sends the current step to the customer', () => {
  assert.deepEqual(core.planAction(LEAD(), SETTINGS(), 'Pearlview Window Cleaning'), {
    type: 'send', stepIndex: 0, to: 'jane@x.com', realTo: 'jane@x.com', test: false, subject: 'S1 Jane', text: 'B1 Jane $350',
  });
  assert.equal(core.planAction(LEAD({ followup_step: 2 }), SETTINGS(), 'Pearlview').subject, 'S3 Pearlview');
});

test('planAction: test mode redirects TEST leads and holds real ones', () => {
  const s = { ...SETTINGS(), test_mode: true };
  const t = core.planAction(LEAD({ client_name: 'TEST Full Run' }), s, 'P');
  assert.equal(t.type, 'send');
  assert.equal(t.to, 'owner@test.com');
  assert.equal(t.test, true);
  assert.equal(t.subject, '[TEST → jane@x.com] S1 TEST');
  assert.deepEqual(core.planAction(LEAD(), s, 'P'), { type: 'hold', reason: 'test_mode' });
});

test('planAction: test mode with no valid test email holds even TEST leads', () => {
  for (const test_email of ['', null, 'nope']) {
    const s = { ...SETTINGS(), test_mode: true, test_email };
    assert.deepEqual(core.planAction(LEAD({ client_name: 'TEST x' }), s, 'P'), { type: 'hold', reason: 'no_test_email' });
  }
});

test('planAction: disabled or empty steps are skipped, finished sequences complete', () => {
  const s = SETTINGS();
  s.steps[1].enabled = false;
  s.steps[2].subject = '  ';
  assert.deepEqual(core.planAction(LEAD({ followup_step: 1 }), s, 'P'), { type: 'skip', stepIndex: 1 });
  assert.deepEqual(core.planAction(LEAD({ followup_step: 2 }), s, 'P'), { type: 'skip', stepIndex: 2 });
  assert.deepEqual(core.planAction(LEAD({ followup_step: 3 }), s, 'P'), { type: 'complete' });
  assert.deepEqual(core.planAction(LEAD(), { ...s, steps: null }, 'P'), { type: 'complete' });
});

test('planAction: lead without a usable email → no_email', () => {
  assert.deepEqual(core.planAction(LEAD({ email: '  ' }), SETTINGS(), 'P'), { type: 'no_email' });
});

test('afterStep schedules the next step from now', () => {
  assert.deepEqual(core.afterStep(SETTINGS(), 0, NOW, { sent: true }), {
    followup_step: 1, followup_next_at: '2026-10-15T00:00:00.000Z', followup_fail_count: 0,
  });
});

test('afterStep after the final SENT step closes the lead as Refused', () => {
  assert.deepEqual(core.afterStep(SETTINGS(), 2, NOW, { sent: true }), {
    followup_step: 3, followup_status: 'completed', followup_next_at: null, followup_fail_count: 0,
    lead_status: 'Refused', refusal_reason: 'no_response',
  });
});

test('afterStep after a SKIPPED final step completes without touching the status', () => {
  assert.deepEqual(core.afterStep(SETTINGS(), 2, NOW, { sent: false }), {
    followup_step: 3, followup_status: 'completed', followup_next_at: null, followup_fail_count: 0,
  });
});

test('afterFailure retries in 1h and gives up on the 3rd failure', () => {
  assert.deepEqual(core.afterFailure(LEAD({ followup_fail_count: 0 }), NOW), {
    followup_fail_count: 1, followup_next_at: '2026-10-12T01:00:00.000Z',
  });
  assert.deepEqual(core.afterFailure(LEAD({ followup_fail_count: 2 }), NOW), {
    followup_fail_count: 3, followup_status: 'error', followup_stop_reason: 'send_failed', followup_next_at: null,
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd whatsapp-service && node --test followup-core.test.js`
Expected: the 11 Task 1 tests PASS; the new tests FAIL with `core.inSendWindow is not a function` (and similar).

- [ ] **Step 3: Implement**

In `whatsapp-service/followup-core.js`, insert this block **above** `module.exports`:

```js
// ─── Scheduling decisions ────────────────────────────────────────────────────
const DEFAULT_DELAY_HOURS = [48, 72, 120];
const MAX_FAILS = 3;
const HOUR_MS = 3600 * 1000;

function localHour(now, tz) {
  const part = new Intl.DateTimeFormat('en-AU', { hour: 'numeric', hourCycle: 'h23', timeZone: tz })
    .formatToParts(now).find(p => p.type === 'hour');
  return parseInt(part.value, 10) % 24;
}

function inSendWindow(now, tz, startHour, endHour) {
  const start = Number.isInteger(startHour) ? startHour : 8;
  const end = Number.isInteger(endHour) ? endHour : 18;
  const h = localHour(now, tz);
  return h >= start && h < end;
}

function isTestLead(name) {
  return /^\s*test\b/i.test(String(name || ''));
}

function delayHours(steps, i) {
  const raw = steps?.[i]?.delay_hours;
  const d = typeof raw === 'number' ? raw : parseFloat(raw);
  return Number.isFinite(d) && d >= 0 ? d : (DEFAULT_DELAY_HOURS[i] ?? 72);
}

// What to do with ONE due lead. `followup_step` = number of steps already
// processed, i.e. the index of the step to handle now.
function planAction(lead, settings, fallbackCompany) {
  const steps = Array.isArray(settings.steps) ? settings.steps : [];
  const i = Number(lead.followup_step) || 0;
  if (i >= steps.length) return { type: 'complete' };

  const test = !!settings.test_mode;
  if (test && !isTestLead(lead.client_name)) return { type: 'hold', reason: 'test_mode' };

  const step = steps[i] || {};
  if (step.enabled === false) return { type: 'skip', stepIndex: i };

  const realTo = cleanEmail(lead.email);
  if (!realTo) return { type: 'no_email' };

  let to = realTo;
  if (test) {
    to = cleanEmail(settings.test_email);
    if (!to) return { type: 'hold', reason: 'no_test_email' }; // never fall through to the customer
  }

  const ctx = buildContext(lead, settings, fallbackCompany);
  const subject = renderTemplate(step.subject, ctx).trim();
  const text = renderTemplate(step.body, ctx).trim();
  if (!subject || !text) return { type: 'skip', stepIndex: i }; // never send an empty email

  return { type: 'send', stepIndex: i, to, realTo, test, subject: test ? `[TEST → ${realTo}] ${subject}` : subject, text };
}

// Column patch after step `stepIndex` was processed (sent or skipped). A
// disabled step's wait still elapses, so later steps keep their timing.
function afterStep(settings, stepIndex, now, { sent }) {
  const steps = Array.isArray(settings.steps) ? settings.steps : [];
  const next = stepIndex + 1;
  if (next < steps.length) {
    return {
      followup_step: next,
      followup_next_at: new Date(now.getTime() + delayHours(steps, next) * HOUR_MS).toISOString(),
      followup_fail_count: 0,
    };
  }
  const done = { followup_step: next, followup_status: 'completed', followup_next_at: null, followup_fail_count: 0 };
  // The final email tells the customer we're closing their inquiry — so we do.
  return sent ? { ...done, lead_status: 'Refused', refusal_reason: REFUSAL_CODE } : done;
}

function afterFailure(lead, now) {
  const fails = (Number(lead.followup_fail_count) || 0) + 1;
  if (fails >= MAX_FAILS) {
    return { followup_fail_count: fails, followup_status: 'error', followup_stop_reason: 'send_failed', followup_next_at: null };
  }
  return { followup_fail_count: fails, followup_next_at: new Date(now.getTime() + HOUR_MS).toISOString() };
}
```

Replace the `module.exports` block with:

```js
module.exports = {
  FOLLOWUP_HEADER, FOLLOWUP_KIND, REFUSAL_CODE, DEFAULT_DELAY_HOURS, MAX_FAILS,
  cleanEmail, firstName, formatMoney, renderTemplate, buildContext,
  htmlFromText, b64url, buildFollowupMime, isFollowupMessage, replyAlertText,
  localHour, inSendWindow, isTestLead, delayHours, planAction, afterStep, afterFailure,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd whatsapp-service && node --test followup-core.test.js`
Expected: PASS — 23 tests, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add whatsapp-service/followup-core.js whatsapp-service/followup-core.test.js
git commit -m "feat(followups): pure scheduling decisions (plan/after-step/failure/window)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Engine orchestration (`followup.js`) + data access + WhatsApp text

**Files:**
- Create: `whatsapp-service/followup.js`
- Create: `whatsapp-service/followup.test.js`
- Modify: `whatsapp-service/sb.js` (add 5 functions + exports)
- Modify: `whatsapp-service/greenapi.js` (add `sendText` + export)

**Interfaces:**
- Consumes: everything from Tasks 1–2; `config.js` → `BUSINESS`, `DASHBOARD_URL`, `TZ`; `email-extractor.js` → `buildOAuthClient()`.
- Produces:
  - `followup.js`: `runFollowups({dry?: boolean, now?: Date, deps?: object}) → Promise<object>`; result is either `{skipped: 'supabase_off'|'not_set_up'|'disabled'|'outside_window'}` or `{dry, enabled, testMode, inWindow, due, sent, held, skipped, replied, completed, errors, actions: [{id, name, step, type, to?}]}`.
  - `deps` shape: `getSettings() → row|null`, `fetchDue({nowIso, testOnly, limit}) → rows`, `claim(id, step, now, leaseMin) → bool`, `update(id, cols) → bool`, `log(row) → void`, `sendEmail({to, subject, text, html}) → messageId`, `hasReplied(email, sinceIso) → bool`, `alertOwner(lead) → void`.
  - `sb.js`: `getFollowupSettings()`, `fetchDueFollowups({nowIso, testOnly, limit})`, `claimFollowup(id, step, now, leaseMin)`, `updateActiveFollowup(id, cols)`, `insertFollowupLog(row)`.
  - `greenapi.js`: `sendText(to: string, message: string) → Promise<object>`.

- [ ] **Step 1: Write the failing tests**

Create `whatsapp-service/followup.test.js`:

```js
// Orchestration tests for runFollowups() against fake deps (no DB / Gmail).
// Run: node --test followup.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { runFollowups } = require('./followup');

const NOW = new Date('2026-10-12T00:00:00Z'); // 11:00 Sydney — inside 8–18
const LATE = new Date('2026-10-12T10:00:00Z'); // 21:00 Sydney — outside
const SETTINGS = (o = {}) => ({
  enabled: true, test_mode: false, test_email: 'owner@test.com', sender_name: 'Pearlview',
  window_start_hour: 8, window_end_hour: 18,
  steps: [
    { enabled: true, delay_hours: 48, subject: 'S1', body: 'Hi {first_name}' },
    { enabled: true, delay_hours: 72, subject: 'S2', body: 'B2' },
    { enabled: true, delay_hours: 120, subject: 'S3', body: 'B3' },
  ],
  ...o,
});
const LEAD = (o = {}) => ({
  id: 'L1', client_name: 'Jane Smith', email: 'jane@x.com', quote_amount: 350,
  quote_sent_at: '2026-10-09T00:00:00Z', followup_step: 0, followup_fail_count: 0, ...o,
});

function fakeDeps({ settings = SETTINGS(), leads = [LEAD()], claim = true, replied = false, sendFails = false } = {}) {
  const calls = { fetch: [], claim: [], update: [], log: [], send: [], alert: [] };
  return {
    calls,
    deps: {
      getSettings: async () => settings,
      fetchDue: async args => { calls.fetch.push(args); return leads; },
      claim: async (id, step) => { calls.claim.push([id, step]); return claim; },
      update: async (id, cols) => { calls.update.push([id, cols]); return true; },
      log: async row => { calls.log.push(row); },
      sendEmail: async msg => { calls.send.push(msg); if (sendFails) throw new Error('gmail down'); return 'msg-1'; },
      hasReplied: async () => replied,
      alertOwner: async lead => { calls.alert.push(lead.id); },
    },
  };
}

test('skips entirely when disabled or outside the send window', async () => {
  let f = fakeDeps({ settings: SETTINGS({ enabled: false }) });
  assert.deepEqual(await runFollowups({ now: NOW, deps: f.deps }), { skipped: 'disabled' });
  f = fakeDeps();
  assert.deepEqual(await runFollowups({ now: LATE, deps: f.deps }), { skipped: 'outside_window' });
  assert.equal(f.calls.send.length, 0);
});

test('not set up (no settings row) → skipped', async () => {
  const f = fakeDeps({ settings: null });
  assert.deepEqual(await runFollowups({ now: NOW, deps: f.deps }), { skipped: 'not_set_up' });
});

test('sends a due step, logs it and schedules the next one', async () => {
  const f = fakeDeps();
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.sent, 1);
  assert.equal(f.calls.send[0].to, 'jane@x.com');
  assert.equal(f.calls.send[0].subject, 'S1');
  assert.equal(f.calls.send[0].text, 'Hi Jane');
  assert.match(f.calls.send[0].html, /<p /);
  assert.deepEqual(f.calls.log[0], { lead_id: 'L1', step: 1, to_email: 'jane@x.com', test_mode: false, gmail_message_id: 'msg-1' });
  assert.deepEqual(f.calls.update[0], ['L1', { followup_step: 1, followup_next_at: '2026-10-15T00:00:00.000Z', followup_fail_count: 0 }]);
});

test('final step closes the lead as Refused', async () => {
  const f = fakeDeps({ leads: [LEAD({ followup_step: 2 })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.update[0][1].lead_status, 'Refused');
  assert.equal(f.calls.update[0][1].refusal_reason, 'no_response');
  assert.equal(f.calls.update[0][1].followup_status, 'completed');
});

test('a lost claim sends nothing and writes nothing', async () => {
  const f = fakeDeps({ claim: false });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.sent, 0);
  assert.equal(f.calls.send.length, 0);
  assert.equal(f.calls.update.length, 0);
});

test('a customer reply stops the sequence and alerts the owner instead of sending', async () => {
  const f = fakeDeps({ replied: true });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.replied, 1);
  assert.equal(f.calls.send.length, 0);
  assert.deepEqual(f.calls.update[0], ['L1', { followup_status: 'replied', followup_stop_reason: 'replied', followup_next_at: null }]);
  assert.deepEqual(f.calls.alert, ['L1']);
});

test('send failure is logged and retried; the third failure marks error', async () => {
  let f = fakeDeps({ sendFails: true });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.errors, 1);
  assert.equal(f.calls.log[0].error, 'gmail down');
  assert.deepEqual(f.calls.update[0], ['L1', { followup_fail_count: 1, followup_next_at: '2026-10-12T01:00:00.000Z' }]);
  f = fakeDeps({ sendFails: true, leads: [LEAD({ followup_fail_count: 2 })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.update[0][1].followup_status, 'error');
});

test('test mode only fetches TEST leads and redirects to the test inbox', async () => {
  const f = fakeDeps({ settings: SETTINGS({ test_mode: true }), leads: [LEAD({ client_name: 'TEST Full Run' })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(f.calls.fetch[0].testOnly, true);
  assert.equal(f.calls.send[0].to, 'owner@test.com');
  assert.equal(f.calls.log[0].test_mode, true);
});

test('held real leads are not claimed or touched in test mode', async () => {
  const f = fakeDeps({ settings: SETTINGS({ test_mode: true }), leads: [LEAD()] });
  const out = await runFollowups({ now: NOW, deps: f.deps });
  assert.equal(out.held, 1);
  assert.equal(f.calls.claim.length, 0);
  assert.equal(f.calls.update.length, 0);
});

test('a lead with no usable email is parked as no_email', async () => {
  const f = fakeDeps({ leads: [LEAD({ email: '' })] });
  await runFollowups({ now: NOW, deps: f.deps });
  assert.deepEqual(f.calls.update[0], ['L1', { followup_status: 'no_email', followup_next_at: null }]);
  assert.equal(f.calls.send.length, 0);
});

test('dry run reports the plan without claiming/sending — even when disabled and outside the window', async () => {
  const f = fakeDeps({ settings: SETTINGS({ enabled: false }) });
  const out = await runFollowups({ dry: true, now: LATE, deps: f.deps });
  assert.equal(out.dry, true);
  assert.equal(out.enabled, false);
  assert.equal(out.inWindow, false);
  assert.deepEqual(out.actions, [{ id: 'L1', name: 'Jane Smith', step: 0, type: 'send', to: 'jane@x.com' }]);
  assert.equal(f.calls.claim.length + f.calls.send.length + f.calls.update.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd whatsapp-service && node --test followup.test.js`
Expected: FAIL — `Cannot find module './followup'`.

- [ ] **Step 3: Add the data-access functions to `sb.js`**

In `whatsapp-service/sb.js`, insert above `module.exports`:

```js
// ── Quote follow-ups (followup.js). Raw snake_case rows — no field-name mapping.
const QUOTE_SENT = encodeURIComponent('Quote Sent');

async function getFollowupSettings() {
  try {
    const r = await axios.get(`${URL()}/rest/v1/followup_settings?id=eq.1&select=*`, { headers: H() });
    return r.data[0] || null;
  } catch (err) {
    if (err.response?.status === 404) return null; // table not created on this branch yet
    throw err;
  }
}

async function fetchDueFollowups({ nowIso, testOnly, limit }) {
  let q = `leads?followup_status=eq.active&lead_status=eq.${QUOTE_SENT}&followup_next_at=lte.${encodeURIComponent(nowIso)}`
    + '&select=id,client_name,email,quote_amount,quote_sent_at,followup_step,followup_fail_count'
    + `&order=followup_next_at.asc&limit=${limit}`;
  if (testOnly) q += '&client_name=ilike.test*'; // test mode: held real leads never crowd out TEST leads
  const r = await axios.get(`${URL()}/rest/v1/${q}`, { headers: H() });
  return r.data || [];
}

// Atomically take a due lead for this run by pushing next_at forward (a lease).
// false = another run took it, or its state changed since it was selected.
async function claimFollowup(id, step, now, leaseMin) {
  const q = `leads?id=eq.${id}&followup_status=eq.active&followup_step=eq.${step}&lead_status=eq.${QUOTE_SENT}`
    + `&followup_next_at=lte.${encodeURIComponent(now.toISOString())}`;
  const lease = new Date(now.getTime() + leaseMin * 60000).toISOString();
  const r = await axios.patch(`${URL()}/rest/v1/${q}`, { followup_next_at: lease },
    { headers: { ...H(), Prefer: 'return=representation' } });
  return Array.isArray(r.data) && r.data.length === 1;
}

// Apply a follow-up state change ONLY while the lead is still active + in Quote
// Sent — a status the owner set mid-run (e.g. Booked) is never overwritten.
async function updateActiveFollowup(id, cols) {
  const q = `leads?id=eq.${id}&followup_status=eq.active&lead_status=eq.${QUOTE_SENT}`;
  const r = await axios.patch(`${URL()}/rest/v1/${q}`, cols, { headers: { ...H(), Prefer: 'return=representation' } });
  return Array.isArray(r.data) && r.data.length === 1;
}

async function insertFollowupLog(row) {
  await axios.post(`${URL()}/rest/v1/followup_log`, row, { headers: H() });
}
```

Replace its `module.exports` line with:

```js
module.exports = {
  USE_SUPABASE, getLeadById, updateLead, nextInvoiceNumber, createBooking, fetchActiveBookings, findLead, createLead,
  getLeadsForContext, getFacebookLeadIds,
  getFollowupSettings, fetchDueFollowups, claimFollowup, updateActiveFollowup, insertFollowupLog,
};
```

- [ ] **Step 4: Add `sendText` to `greenapi.js`**

In `whatsapp-service/greenapi.js`, insert above `module.exports`:

```js
// Plain text to one WhatsApp number (E.164 digits, no +). Used for owner alerts
// that aren't lead notifications (e.g. a customer replied to a quote follow-up).
async function sendText(to, message) {
  const idInstance = process.env.GREENAPI_INSTANCE_ID;
  const apiToken = process.env.GREENAPI_TOKEN;
  if (!idInstance || !apiToken) throw new Error('GREENAPI_INSTANCE_ID or GREENAPI_TOKEN not set');
  const url = `${BASE_URL}/waInstance${idInstance}/sendMessage/${apiToken}`;
  const r = await axios.post(url, { chatId: `${to}@c.us`, message, linkPreview: false },
    { headers: { 'Content-Type': 'application/json' } });
  return r.data;
}
```

Replace its `module.exports` line with:

```js
module.exports = { sendLeadNotification, buildLeadMessage, getInstanceState, sendText };
```

- [ ] **Step 5: Implement `followup.js`**

Create `whatsapp-service/followup.js`:

```js
/**
 * followup.js — the quote follow-up job. Cloud Scheduler calls
 * POST /run-followups every 15 min → runFollowups(). Every decision comes from
 * followup-core.js (pure, unit-tested); this file only does I/O, and all I/O
 * goes through `deps` so followup.test.js can run it against fakes.
 */
const { google } = require('googleapis');
const sb = require('./sb');
const core = require('./followup-core');
const { BUSINESS, DASHBOARD_URL, TZ } = require('./config');

const BATCH = 25;     // leads per run
const LEASE_MIN = 10; // claim lease — a crashed run frees its leads after this

function gmailFor(refreshToken) {
  // Lazy require: email-extractor is the whole ingestion module; load only to send/search.
  const { buildOAuthClient } = require('./email-extractor');
  const oauth2 = buildOAuthClient();
  oauth2.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: 'v1', auth: oauth2 });
}

// Same sender as invoices: the dedicated SEND token, From/Reply-To = BUSINESS.email.
async function sendEmail({ to, subject, text, html }) {
  const gmail = gmailFor(process.env.GMAIL_SEND_REFRESH_TOKEN || process.env.GMAIL_FORM_REFRESH_TOKEN);
  const mime = core.buildFollowupMime({ fromName: BUSINESS.name, fromEmail: BUSINESS.email, to, subject, text, html });
  const r = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: core.b64url(mime) } });
  return r.data.id;
}

// Replies go to Reply-To = BUSINESS.email (service@…), which is the FORM inbox
// the email extractor already reads — so search it with the form token.
async function hasReplied(email, since) {
  const token = process.env.GMAIL_FORM_REFRESH_TOKEN;
  if (!token || !email || !since) return false;
  const after = Math.floor(new Date(since).getTime() / 1000);
  const r = await gmailFor(token).users.messages.list({
    userId: 'me', q: `from:${email} after:${after} -in:sent -in:chats`, maxResults: 1,
  });
  return (r.data.messages || []).length > 0;
}

async function alertOwner(lead) {
  const { sendText, getInstanceState } = require('./greenapi');
  const recipients = (process.env.OWNER_PHONE || '').split(',').map(p => p.replace(/[^\d]/g, '')).filter(Boolean);
  if (!recipients.length) return;
  const state = await getInstanceState();
  if (state !== 'authorized') {
    console.error(`[ALERT] 🚨 Green-API not authorized (state=${state}) — follow-up reply alert NOT sent for ${lead.id}`);
    return;
  }
  const msg = core.replyAlertText(lead, BUSINESS.email, DASHBOARD_URL);
  await Promise.allSettled(recipients.map(to => sendText(to, msg)));
}

const realDeps = {
  getSettings: sb.getFollowupSettings,
  fetchDue: sb.fetchDueFollowups,
  claim: sb.claimFollowup,
  update: sb.updateActiveFollowup,
  log: sb.insertFollowupLog,
  sendEmail,
  hasReplied,
  alertOwner,
};

async function runFollowups({ dry = false, now = new Date(), deps = realDeps } = {}) {
  if (deps === realDeps && !sb.USE_SUPABASE) return { skipped: 'supabase_off' };
  const settings = await deps.getSettings();
  if (!settings) return { skipped: 'not_set_up' };
  const inWindow = core.inSendWindow(now, TZ, settings.window_start_hour, settings.window_end_hour);
  // A dry run always reports the plan, so it can be checked before switching on.
  if (!dry && !settings.enabled) return { skipped: 'disabled' };
  if (!dry && !inWindow) return { skipped: 'outside_window' };

  const leads = await deps.fetchDue({ nowIso: now.toISOString(), testOnly: !!settings.test_mode, limit: BATCH });
  const out = {
    dry, enabled: !!settings.enabled, testMode: !!settings.test_mode, inWindow, due: leads.length,
    sent: 0, held: 0, skipped: 0, replied: 0, completed: 0, errors: 0, actions: [],
  };

  for (const lead of leads) {
    const action = core.planAction(lead, settings, BUSINESS.name);
    out.actions.push({ id: lead.id, name: lead.client_name, step: lead.followup_step, type: action.type, ...(action.to ? { to: action.to } : {}) });
    if (dry) continue;
    if (action.type === 'hold') { out.held++; continue; }

    try {
      if (!(await deps.claim(lead.id, lead.followup_step, now, LEASE_MIN))) continue;

      if (action.type === 'complete') {
        await deps.update(lead.id, { followup_status: 'completed', followup_next_at: null });
        out.completed++;
        continue;
      }
      if (action.type === 'no_email') {
        await deps.update(lead.id, { followup_status: 'no_email', followup_next_at: null });
        continue;
      }
      if (action.type === 'skip') {
        await deps.update(lead.id, core.afterStep(settings, action.stepIndex, now, { sent: false }));
        out.skipped++;
        continue;
      }

      // send — but never after the customer has already written back
      if (await deps.hasReplied(core.cleanEmail(lead.email), lead.quote_sent_at)) {
        await deps.update(lead.id, { followup_status: 'replied', followup_stop_reason: 'replied', followup_next_at: null });
        out.replied++;
        await deps.alertOwner(lead).catch(e => console.error('[followups] owner alert failed:', e.message));
        continue;
      }

      const step = action.stepIndex + 1;
      let messageId;
      try {
        messageId = await deps.sendEmail({ to: action.to, subject: action.subject, text: action.text, html: core.htmlFromText(action.text) });
      } catch (err) {
        const msg = String(err.message || err).slice(0, 500);
        console.error(`[ALERT] 🚨 [followups] send failed for ${lead.id} (FU${step}): ${msg}`);
        await deps.log({ lead_id: lead.id, step, to_email: action.to, test_mode: action.test, error: msg });
        await deps.update(lead.id, core.afterFailure(lead, now));
        out.errors++;
        continue;
      }
      await deps.log({ lead_id: lead.id, step, to_email: action.to, test_mode: action.test, gmail_message_id: messageId });
      await deps.update(lead.id, core.afterStep(settings, action.stepIndex, now, { sent: true }));
      out.sent++;
      console.log(`[followups] FU${step} sent to ${action.to} for ${lead.client_name} (${lead.id})${action.test ? ' [TEST]' : ''}`);
    } catch (err) {
      // e.g. Gmail/DB outage during the reply check — the lease expires and a later run retries.
      console.error(`[ALERT] 🚨 [followups] lead ${lead.id} failed: ${err.message}`);
      out.errors++;
    }
  }
  return out;
}

module.exports = { runFollowups };
```

- [ ] **Step 6: Run all backend tests**

Run: `cd whatsapp-service && node --test followup-core.test.js followup.test.js`
Expected: PASS — 34 tests, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add whatsapp-service/followup.js whatsapp-service/followup.test.js whatsapp-service/sb.js whatsapp-service/greenapi.js
git commit -m "feat(followups): follow-up engine with claim lease, reply check and owner alert

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Tick PMS** — run the Global Constraints PMS snippet with `"Engine:"`.

---

### Task 4: `/run-followups` endpoint + extractor guard

**Files:**
- Modify: `whatsapp-service/index.js` (import + endpoint above `// ─── Start server`)
- Modify: `whatsapp-service/email-extractor.js` (import, query `-in:sent`, skip own follow-ups)

**Interfaces:**
- Consumes: `runFollowups` (Task 3), `isFollowupMessage` (Task 1).
- Produces: `POST /run-followups[?dry=true]`, header `x-cron-secret` must equal env `CRON_SECRET` → `200 {success:true, result}` | `401 {error:'unauthorized'}` | `500 {error}`.

- [ ] **Step 1: Add the endpoint**

In `whatsapp-service/index.js`, add after the `require('./booking-page')` line:

```js
const { runFollowups } = require('./followup');
```

Insert directly above `// ─── Start server ───`:

```js
// ─── Quote follow-ups (Cloud Scheduler, every 15 min) ────────────────────────
// Emails customers, so unlike /extract-emails it is secret-protected.
// ?dry=true → returns the planned actions without sending or writing anything.
app.post('/run-followups', async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('x-cron-secret') !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const result = await runFollowups({ dry: req.query.dry === 'true' });
    res.json({ success: true, result });
  } catch (err) {
    console.error('[ALERT] 🚨 Follow-up run failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add the extractor guard**

In `whatsapp-service/email-extractor.js`, add after `const { syncContactToList } = require('./mobilemessage');`:

```js
const { isFollowupMessage } = require('./followup-core');
```

In `extractFormLeads`, replace:

```js
  const query = `(${FORM_GMAIL_MATCH}) -label:"${FORM_LABEL_NAME}" -subject:"New Facebook lead" -subject:"New Instagram lead" ${dateFilter}`;
```

with:

```js
  const query = `(${FORM_GMAIL_MATCH}) -label:"${FORM_LABEL_NAME}" -subject:"New Facebook lead" -subject:"New Instagram lead" -in:sent ${dateFilter}`;
```

In the same loop, directly after the `if (/^\s*new (facebook|instagram) lead:/i.test(subject)) { … continue; }` block, insert:

```js
      // Never ingest our own quote follow-up emails: they're From service@… which
      // FORM_GMAIL_MATCH's `from:pearlview.com.au` would otherwise match. Label
      // them so they aren't re-fetched (and crowd out real leads) every run.
      if (isFollowupMessage(message.payload?.headers)) {
        console.log(`[email-extractor] Skipping own follow-up email: ${subject}`);
        await applyLabel(gmail, message.id, labelId);
        continue;
      }
```

- [ ] **Step 3: Smoke-test locally**

Start the service in the background (Bash tool, `run_in_background: true`):
```bash
cd whatsapp-service && CRON_SECRET=local-test PORT=8091 node index.js
```
Then run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:8091/run-followups
curl -s -X POST "http://localhost:8091/run-followups?dry=true" -H "x-cron-secret: local-test"
```
Expected: `401`, then `{"success":true,"result":{"skipped":"supabase_off"}}` (the local `whatsapp-service/.env` has no `USE_SUPABASE`) or `{"skipped":"not_set_up"}`. Stop the background server.

- [ ] **Step 4: Re-run backend tests** (the extractor now requires followup-core)

Run: `cd whatsapp-service && node --test followup-core.test.js followup.test.js && node -e "require('./email-extractor'); console.log('extractor loads')"`
Expected: 34 PASS, then `extractor loads`.

- [ ] **Step 5: Commit**

```bash
git add whatsapp-service/index.js whatsapp-service/email-extractor.js
git commit -m "feat(followups): secret-protected /run-followups + extractor skips own follow-ups

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Tick PMS** with `"Extractor guard"`.

---

### Task 5: Database — columns, settings, log, RLS, enrollment trigger, view

**Files:**
- Create: `execution/supabase_followups.sql`
- Create: `execution/test_followup_trigger.mjs`

**Interfaces:**
- Consumes: `is_owner()` (exists on NSW — verified 2026-10-10), the current `leads_enriched` definition (`execution/supabase_fix_leads_enriched_lead_id.sql`), `sb.updateActiveFollowup` (Task 3).
- Produces: `leads.{quote_sent_at, followup_status, followup_step, followup_next_at, followup_stop_reason, followup_fail_count}`; tables `followup_settings` (row `id=1`, incl. `company_name`) and `followup_log`; trigger `leads_followup_enroll`; `leads_enriched` exposing the new columns. The seed JSON sits between `$steps$` markers — Task 6's test parses it.

- [ ] **Step 1: Write the SQL**

Create `execution/supabase_followups.sql`:

```sql
-- Quote follow-ups — spec: docs/superpowers/specs/2026-10-09-quote-followups-design.md
-- Run ONCE in the Supabase SQL editor (NSW project zagmrxxmhyprhnhucqpo). Safe to re-run.
-- Ships OFF (enabled=false) and in test mode. Then verify:
--   node --env-file=.env execution/test_followup_trigger.mjs
begin;

-- 1. follow-up state on each lead
alter table leads
  add column if not exists quote_sent_at        timestamptz,
  add column if not exists followup_status      text,
  add column if not exists followup_step        int not null default 0,
  add column if not exists followup_next_at     timestamptz,
  add column if not exists followup_stop_reason text,
  add column if not exists followup_fail_count  int not null default 0;
create index if not exists leads_followup_due_idx on leads (followup_status, followup_next_at);

-- 2. owner settings — a single row (id = 1)
create table if not exists followup_settings (
  id                int primary key default 1 check (id = 1),
  enabled           boolean not null default false,
  test_mode         boolean not null default true,
  test_email        text,
  sender_name       text not null default 'Pearlview Window Cleaning',
  company_name      text not null default 'Pearlview Window Cleaning',
  window_start_hour int not null default 8  check (window_start_hour between 0 and 23),
  window_end_hour   int not null default 18 check (window_end_hour between 1 and 24),
  steps             jsonb not null,
  updated_at        timestamptz not null default now()
);

insert into followup_settings (id, steps) values (1, $steps$[
  {"enabled": true, "delay_hours": 48,
   "subject": "Quick check-in regarding your window cleaning quote!",
   "body": "Hi {first_name},\n\nI hope you're having a great week! I just wanted to quickly follow up on the quote we sent over for your window cleaning.\n\nDid you have any questions about the service details or pricing? We'd love to get your windows sparkling clean!\n\nBest regards,\n{sender}"},
  {"enabled": true, "delay_hours": 72,
   "subject": "Flexible scheduling available for your window cleaning",
   "body": "Hi {first_name},\n\nFollowing up on my previous message! I wanted to let you know we have a few open spots available on our schedule for this coming week.\n\nIf you have a specific day or time in mind that works best for you, let us know and we'll be happy to reserve it for you.\n\nBest regards,\n{sender}"},
  {"enabled": true, "delay_hours": 120,
   "subject": "Final check-in from {company}",
   "body": "Hi {first_name},\n\nI haven't heard back from you, so I assume you may have put your window cleaning project on hold for now.\n\nI'll go ahead and close out your inquiry in our system so we don't bother you with further messages. If you ever need us in the future, please feel free to reach out anytime!\n\nWarm regards,\n{sender}"}
]$steps$::jsonb)
on conflict (id) do nothing;

-- 3. send history
create table if not exists followup_log (
  id               uuid primary key default gen_random_uuid(),
  lead_id          uuid not null references leads(id) on delete cascade,
  step             int not null,
  sent_at          timestamptz not null default now(),
  to_email         text,
  test_mode        boolean not null default false,
  gmail_message_id text,
  error            text
);
create index if not exists followup_log_lead_idx on followup_log (lead_id, sent_at desc);

-- 4. owner-only access (the backend uses service_role, which bypasses RLS)
alter table followup_settings enable row level security;
alter table followup_log      enable row level security;
drop policy if exists owner_all on followup_settings;
create policy owner_all on followup_settings for all using (is_owner()) with check (is_owner());
drop policy if exists owner_all on followup_log;
create policy owner_all on followup_log for all using (is_owner()) with check (is_owner());
grant select, insert, update, delete on followup_settings, followup_log to authenticated;

-- 5. enrollment trigger — fires for EVERY write path (Kanban, panel, backend)
create or replace function leads_followup_enroll() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  v_enabled boolean;
  v_steps   jsonb;
  v_delay   numeric;
begin
  select enabled, steps into v_enabled, v_steps from followup_settings where id = 1;
  v_enabled := coalesce(v_enabled, false);
  -- a bad settings value must never block a lead save → safe cast, default 48h
  begin
    v_delay := (v_steps->0->>'delay_hours')::numeric;
  exception when others then
    v_delay := null;
  end;
  if v_delay is null or v_delay < 0 then v_delay := 48; end if;

  -- (a) entering Quote Sent → stamp it; enroll only while the feature is on
  if new.lead_status = 'Quote Sent'
     and (tg_op = 'INSERT' or old.lead_status is distinct from 'Quote Sent') then
    new.quote_sent_at        := now();
    new.followup_step        := 0;
    new.followup_fail_count  := 0;
    new.followup_stop_reason := null;
    new.followup_next_at     := null;
    if not v_enabled then
      new.followup_status := null;
    elsif coalesce(btrim(new.email), '') = '' then
      new.followup_status := 'no_email';
    else
      new.followup_status  := 'active';
      new.followup_next_at := now() + v_delay * interval '1 hour';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- (b) leaving Quote Sent while active → stop, unless this same statement
    --     already set the follow-up status (the engine's final Refused+completed)
    if old.lead_status = 'Quote Sent' and new.lead_status is distinct from 'Quote Sent'
       and old.followup_status = 'active'
       and new.followup_status is not distinct from old.followup_status then
      new.followup_status      := 'stopped';
      new.followup_stop_reason := 'status_changed';
      new.followup_next_at     := null;
    end if;
    -- (c) email added to a no_email lead still in Quote Sent → activate (keeps its step)
    if v_enabled and new.lead_status = 'Quote Sent'
       and old.followup_status = 'no_email' and new.followup_status is not distinct from 'no_email'
       and coalesce(btrim(old.email), '') = '' and coalesce(btrim(new.email), '') <> '' then
      new.followup_status  := 'active';
      new.followup_next_at := now() + v_delay * interval '1 hour';
    end if;
  end if;
  return new;
end
$fn$;

drop trigger if exists leads_followup_enroll on leads;
create trigger leads_followup_enroll before insert or update on leads
  for each row execute function leads_followup_enroll();

-- 6. rebuild the dashboard view so `l.*` picks up the new columns. DROP+CREATE
--    (not CREATE OR REPLACE — new columns land before paid_amount → 42P16).
--    Body copied verbatim from supabase_fix_leads_enriched_lead_id.sql.
drop view if exists leads_enriched;

create view leads_enriched
with (security_invoker = true) as
select l.*,
  r.amount           as paid_amount,
  r.payment_method   as payment_method,
  (r.id is not null) as paid,
  r.id               as revenue_record_id
from leads l
left join lateral (
  select * from revenue r
  where r.amount > 0
    and (
      r.lead_id = l.id
      or (
        r.lead_id is null
        and (
             (coalesce(l.phone_number,'') <> '' and regexp_replace(coalesce(r.phone,''),'\s','','g') = regexp_replace(l.phone_number,'\s','','g'))
          or (coalesce(l.phone_number,'') =  '' and lower(coalesce(r.client_name,'')) = lower(coalesce(l.client_name,'')))
        )
      )
    )
  order by (r.lead_id is not null) desc, r.amount desc
  limit 1
) r on true;

grant select on leads_enriched to anon, authenticated, service_role;

commit;
```

- [ ] **Step 2: Write the live verification script**

Create `execution/test_followup_trigger.mjs`:

```js
/* Live check of the follow-up enrollment trigger + guarded engine updates.
   Run AFTER execution/supabase_followups.sql:
     node --env-file=.env execution/test_followup_trigger.mjs     (exit 0 = pass)
   Creates leads named "TEST Trigger …", deletes them at the end, and restores
   followup_settings.enabled. While it runs (seconds) the feature is ON — any real
   lead quoted in that window is enrolled but HELD by test mode. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.USE_SUPABASE = 'true';
const require = createRequire(import.meta.url);
const sb = require('../whatsapp-service/sb.js');

const U = process.env.SUPABASE_URL;
const K = process.env.SUPABASE_SERVICE_ROLE;
const H = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
async function rest(method, path, body) {
  const r = await fetch(`${U}/rest/v1/${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}
const insertLead = async f => (await rest('POST', 'leads', f))[0];
const patchLead = async (id, f) => (await rest('PATCH', `leads?id=eq.${id}`, f))[0];
const getLead = async (id, cols) => (await rest('GET', `leads?id=eq.${id}&select=${cols}`))[0];
const setEnabled = enabled => rest('PATCH', 'followup_settings?id=eq.1', { enabled });

const [orig] = await rest('GET', 'followup_settings?id=eq.1&select=enabled,steps');
assert.ok(orig, 'followup_settings row missing — run execution/supabase_followups.sql first');
const d1 = Number(orig.steps[0].delay_hours);
const created = [];
const EMAIL = 'trigger-check@example.com';

try {
  await setEnabled(true);

  // 1. entering Quote Sent with an email → active, step 0, next_at = quote_sent_at + step-1 delay
  let a = await insertLead({ client_name: 'TEST Trigger Active', email: EMAIL, lead_status: 'New Lead' });
  created.push(a.id);
  assert.equal(a.followup_status, null);
  a = await patchLead(a.id, { lead_status: 'Quote Sent' });
  assert.equal(a.followup_status, 'active');
  assert.equal(a.followup_step, 0);
  assert.ok(a.quote_sent_at);
  const hrs = (new Date(a.followup_next_at) - new Date(a.quote_sent_at)) / 3600e3;
  assert.ok(Math.abs(hrs - d1) < 0.01, `next_at should be +${d1}h, got +${hrs}h`);

  // 2. owner moves it on → stopped; a guarded engine update can no longer touch it
  a = await patchLead(a.id, { lead_status: 'Booked' });
  assert.equal(a.followup_status, 'stopped');
  assert.equal(a.followup_stop_reason, 'status_changed');
  assert.equal(await sb.updateActiveFollowup(a.id, { lead_status: 'Refused', followup_status: 'completed' }), false);
  assert.equal((await getLead(a.id, 'lead_status')).lead_status, 'Booked');

  // 3. the engine's final update (Refused + completed in one statement) is not overridden by the trigger
  const c = await insertLead({ client_name: 'TEST Trigger Close', email: EMAIL, lead_status: 'Quote Sent' });
  created.push(c.id);
  assert.equal(c.followup_status, 'active');
  assert.equal(await sb.updateActiveFollowup(c.id, {
    lead_status: 'Refused', refusal_reason: 'no_response', followup_status: 'completed', followup_step: 3,
  }), true);
  assert.deepEqual(await getLead(c.id, 'lead_status,followup_status'), { lead_status: 'Refused', followup_status: 'completed' });

  // 4. no email → no_email; adding an email activates it
  let n = await insertLead({ client_name: 'TEST Trigger NoEmail', lead_status: 'Quote Sent' });
  created.push(n.id);
  assert.equal(n.followup_status, 'no_email');
  n = await patchLead(n.id, { email: EMAIL });
  assert.equal(n.followup_status, 'active');

  // 5. feature off → quote_sent_at still stamped, not enrolled
  await setEnabled(false);
  const o = await insertLead({ client_name: 'TEST Trigger Off', email: EMAIL, lead_status: 'Quote Sent' });
  created.push(o.id);
  assert.equal(o.followup_status, null);
  assert.ok(o.quote_sent_at);

  // 6. the dashboard view exposes the new columns (and still has the payment join)
  const [v] = await rest('GET', `leads_enriched?id=eq.${o.id}&select=id,quote_sent_at,followup_status,followup_step,followup_next_at,paid`);
  assert.ok(v && 'followup_status' in v && 'paid' in v, 'leads_enriched is missing follow-up columns');

  console.log('PASS — follow-up trigger + guarded updates behave as designed');
} finally {
  for (const id of created) await rest('DELETE', `leads?id=eq.${id}`).catch(e => console.error('cleanup failed', id, e.message));
  await setEnabled(orig.enabled);
}
```

- [ ] **Step 3: Confirm the script fails before the SQL is applied**

Run: `node --env-file=.env execution/test_followup_trigger.mjs`
Expected: FAIL — `GET followup_settings… → 404` (table doesn't exist yet).

- [ ] **Step 4: User runs the SQL**

Ask the user: "Please paste `execution/supabase_followups.sql` into Supabase → SQL Editor (project `zagmrxxmhyprhnhucqpo`) and click Run. It is additive and ships with follow-ups OFF. Tell me when it says Success." **Wait for confirmation.**

- [ ] **Step 5: Verify**

Run: `node --env-file=.env execution/test_followup_trigger.mjs`
Expected: `PASS — follow-up trigger + guarded updates behave as designed`. Then confirm cleanup:
```bash
node --env-file=.env -e "fetch(process.env.SUPABASE_URL+'/rest/v1/leads?client_name=ilike.TEST%20Trigger*&select=id',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE}}).then(r=>r.json()).then(d=>console.log('leftover test leads:',d.length))"
```
Expected: `leftover test leads: 0`.

- [ ] **Step 6: Commit**

```bash
git add execution/supabase_followups.sql execution/test_followup_trigger.mjs
git commit -m "feat(followups): schema, settings/log tables, enrollment trigger, view rebuild

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Tick PMS** with `"DB:"`.

---

### Task 6: Frontend follow-up helpers (`followupTemplate.js`)

**Files:**
- Create: `src/utils/followupTemplate.js`
- Test: `execution/test_followup_template.mjs`

**Interfaces:**
- Consumes: `whatsapp-service/followup-core.js` (parity check only), `execution/supabase_followups.sql` (seed parity).
- Produces (ESM):
  - `PLACEHOLDERS: Array<{key, label}>`, `DEFAULT_STEPS: Array<{enabled, delay_hours, subject, body}>`, `STEP_WAIT_LABELS: string[3]`
  - `firstName`, `formatMoney`, `renderTemplate`, `isTestLead` — identical behaviour to the backend
  - `sampleContext(settings|null) → ctx`
  - `validateSettings(settings) → string[]`
  - `followupChip(lead, settings|null) → {label, bg, color} | null`
  - `describeFollowup(lead, settings|null, now?: Date) → {tone: 'info'|'ok'|'warn'|'muted', text, action: 'stop'|'start'|'resume'|null} | null`
  - `lead` = normalised dashboard lead: `{status, name, email, followupStatus, followupStep, followupNextAt, followupStopReason}`.

- [ ] **Step 1: Write the failing test**

Create `execution/test_followup_template.mjs`:

```js
/* Standalone tests for the frontend follow-up helpers, plus parity with the
   sender (whatsapp-service/followup-core.js) and the SQL seed.
   Run: node execution/test_followup_template.mjs   (exit 0 = pass) */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as fe from '../src/utils/followupTemplate.js';

const require = createRequire(import.meta.url);
const be = require('../whatsapp-service/followup-core.js');

// ── parity: the Settings preview renders exactly what the sender sends ──────
for (const lead of [
  { client_name: 'Jane Smith', quote_amount: 350 },
  { client_name: 'Unknown Caller', quote_amount: 0 },
  { client_name: '—', quote_amount: 1234.5 },
  { client_name: 'TEST Full Run', quote_amount: '980' },
  { client_name: 'Testa Smith', quote_amount: null },
]) {
  assert.equal(fe.firstName(lead.client_name), be.firstName(lead.client_name), `firstName ${lead.client_name}`);
  assert.equal(fe.formatMoney(lead.quote_amount), be.formatMoney(lead.quote_amount), `formatMoney ${lead.quote_amount}`);
  assert.equal(fe.isTestLead(lead.client_name), be.isTestLead(lead.client_name), `isTestLead ${lead.client_name}`);
  const ctx = be.buildContext(lead, { sender_name: 'Brad', company_name: 'Pearlview Window Cleaning' }, 'x');
  for (const s of fe.DEFAULT_STEPS) {
    assert.equal(fe.renderTemplate(s.subject, ctx), be.renderTemplate(s.subject, ctx));
    assert.equal(fe.renderTemplate(s.body, ctx), be.renderTemplate(s.body, ctx));
  }
}

// ── parity: SQL seed == DEFAULT_STEPS ("Reset to default scripts") ──────────
const sql = readFileSync(new URL('./supabase_followups.sql', import.meta.url), 'utf8');
assert.deepEqual(JSON.parse(sql.split('$steps$')[1]), fe.DEFAULT_STEPS, 'SQL seed must equal DEFAULT_STEPS');

// ── validateSettings ─────────────────────────────────────────────────────────
const good = {
  enabled: true, test_mode: true, test_email: 'john@x.com', sender_name: 'Pearlview', company_name: 'Pearlview',
  window_start_hour: 8, window_end_hour: 18, steps: fe.DEFAULT_STEPS.map(s => ({ ...s })),
};
assert.deepEqual(fe.validateSettings(good), []);
assert.match(fe.validateSettings({ ...good, test_email: '' })[0], /test email/i);
assert.deepEqual(fe.validateSettings({ ...good, test_mode: false, test_email: '' }), []);
assert.match(fe.validateSettings({ ...good, window_start_hour: 18, window_end_hour: 8 })[0], /send window/i);
assert.match(fe.validateSettings({ ...good, sender_name: ' ' })[0], /signature/i);
const badStep = { ...good, steps: good.steps.map((s, i) => (i === 1 ? { ...s, subject: '', delay_hours: 0 } : s)) };
assert.deepEqual(fe.validateSettings(badStep), ['Follow-up 2: subject is empty.', 'Follow-up 2: wait must be at least 1 hour.']);
const offStep = { ...good, steps: good.steps.map((s, i) => (i === 1 ? { ...s, enabled: false, subject: '' } : s)) };
assert.deepEqual(fe.validateSettings(offStep), [], 'disabled steps are not validated');

// ── followupChip ─────────────────────────────────────────────────────────────
const S = { ...good, test_mode: false };
const L = o => ({ status: 'quote_sent', name: 'Jane', email: 'j@x.com', followupStatus: 'active', followupStep: 1, ...o });
assert.equal(fe.followupChip(L(), S).label, 'FU 1/3');
assert.equal(fe.followupChip(L(), { ...S, test_mode: true }).label, 'Held');
assert.equal(fe.followupChip(L({ name: 'TEST x' }), { ...S, test_mode: true }).label, 'FU 1/3');
assert.equal(fe.followupChip(L({ followupStatus: 'replied' }), S).label, 'Replied');
assert.equal(fe.followupChip(L({ followupStatus: 'no_email' }), S).label, 'No email');
assert.equal(fe.followupChip(L({ followupStatus: 'stopped' }), S).label, 'FU stopped');
assert.equal(fe.followupChip(L({ followupStatus: 'error' }), S).label, 'FU failed');
assert.equal(fe.followupChip(L({ followupStatus: null }), S), null);
assert.equal(fe.followupChip(L({ status: 'booked' }), S), null);
assert.equal(fe.followupChip(L(), null), null);

// ── describeFollowup → which button the panel offers ────────────────────────
const D = (o, s = S) => fe.describeFollowup(L(o), s, new Date('2026-10-12T00:00:00Z'));
assert.equal(D({}).action, 'stop');
assert.equal(D({ followupStatus: null }).action, 'start');
assert.equal(D({ followupStatus: null, email: '' }).action, null);
assert.equal(D({ followupStatus: 'stopped' }).action, 'resume');
assert.equal(D({ followupStatus: 'replied' }).action, 'resume');
assert.equal(D({ followupStatus: 'error' }).action, 'resume');
assert.equal(D({ followupStatus: 'no_email', email: '' }).action, null);
assert.equal(D({ followupStatus: 'no_email' }).action, 'resume', 'email fixed after the engine parked it');
assert.equal(D({ followupStatus: 'stopped', followupStep: 3 }).action, null, 'nothing left to send');
assert.equal(D({ followupStatus: 'completed', status: 'refused' }).action, null);
assert.match(D({}, { ...S, test_mode: true }).text, /Held/);
assert.match(D({ followupStatus: 'completed', status: 'refused' }).text, /no response/i);
assert.equal(fe.describeFollowup(L({ status: 'booked', followupStatus: 'stopped' }), S), null, 'hidden once the lead moves on');
assert.equal(fe.describeFollowup(L(), null), null, 'hidden when follow-ups are not set up');

console.log('PASS — followupTemplate');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node execution/test_followup_template.mjs`
Expected: FAIL — `Cannot find module '…/src/utils/followupTemplate.js'`.

- [ ] **Step 3: Implement**

Create `src/utils/followupTemplate.js`:

```js
// Quote follow-up helpers for the Settings page, the lead panel and lead cards.
// firstName / formatMoney / renderTemplate / isTestLead MUST behave exactly like
// whatsapp-service/followup-core.js (the sender), and DEFAULT_STEPS must equal
// the seed in execution/supabase_followups.sql — execution/test_followup_template.mjs
// enforces both.

const EMAIL_RE = /^[^\s<>@,;"'()]+@[^\s<>@,;"'()]+\.[^\s<>@,;"'()]+$/;
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
  const hasEmail = EMAIL_RE.test(String(lead.email || '').trim());
  const canGo = hasEmail && step < total;

  switch (lead.followupStatus) {
    case 'active': {
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node execution/test_followup_template.mjs`
Expected: `PASS — followupTemplate`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/followupTemplate.js execution/test_followup_template.mjs
git commit -m "feat(followups): frontend template/status helpers with sender + seed parity tests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Frontend data wiring (client, hook, context, refusal code)

**Files:**
- Modify: `src/utils/supabaseClient.js` (LEAD_COLS, `sbLeadRowToRecord`, 4 new exports)
- Modify: `src/hooks/useLeads.js` (`normaliseRecord`, `startFollowups`, `stopFollowups`, return)
- Modify: `src/context/LeadsContext.jsx` (imports, destructure, settings state, provider value)
- Modify: `src/utils/constants.js` (`REFUSE_LABELS.no_response`)
- Modify: `src/components/StatsRow.jsx` (count `no_response`)
- Modify: `src/components/DetailPanel.jsx:401` (emoji for `no_response`)

**Interfaces:**
- Consumes: DB columns from Task 5.
- Produces:
  - `supabaseClient.js`: `fetchFollowupSettings() → Promise<row|null>`, `saveFollowupSettings(patch) → Promise<row|null>` (throws on failure), `fetchFollowupLog(leadId) → Promise<rows>`, `countActiveFollowups() → Promise<number>`.
  - Normalised lead gains `quoteSentAt, followupStatus, followupStep, followupNextAt, followupStopReason`.
  - Context exposes `followupSettings` (row | null), `setFollowupSettings(row)`, `startFollowups(leadId) → Promise<boolean>`, `stopFollowups(leadId) → Promise<boolean>`.

- [ ] **Step 1: `supabaseClient.js` — map the new columns**

In `LEAD_COLS`, replace:

```js
  'Invoice Number': 'invoice_number', 'Invoice Sent': 'invoice_sent',
};
const REVENUE_COLS = {
```

with:

```js
  'Invoice Number': 'invoice_number', 'Invoice Sent': 'invoice_sent',
  'Quote Sent At': 'quote_sent_at', 'Follow-up Status': 'followup_status', 'Follow-up Step': 'followup_step',
  'Follow-up Next At': 'followup_next_at', 'Follow-up Stop Reason': 'followup_stop_reason', 'Follow-up Fail Count': 'followup_fail_count',
};
const REVENUE_COLS = {
```

In `sbLeadRowToRecord`, replace:

```js
      'Invoice Number': row.invoice_number, 'Invoice Sent': row.invoice_sent,
    },
  };
}
export function sbBookingRowToRecord(row) {
```

with:

```js
      'Invoice Number': row.invoice_number, 'Invoice Sent': row.invoice_sent,
      'Quote Sent At': row.quote_sent_at, 'Follow-up Status': row.followup_status, 'Follow-up Step': row.followup_step,
      'Follow-up Next At': row.followup_next_at, 'Follow-up Stop Reason': row.followup_stop_reason,
    },
  };
}
export function sbBookingRowToRecord(row) {
```

- [ ] **Step 2: `supabaseClient.js` — settings/log helpers**

Insert directly above the `// ── generic CRUD (airtableSync delegates here)` comment:

```js
// ── Quote follow-ups (owner only; RLS hides these from technicians) ─────────
// null = feature not set up on this branch (table missing) / not the owner.
export async function fetchFollowupSettings() {
  try {
    const rows = await sbSelect('followup_settings?id=eq.1&select=*');
    return (rows && rows[0]) || null;
  } catch { return null; }
}
export async function saveFollowupSettings(patch) {
  await ensureToken();
  const r = await fetch(`${SB_URL}/rest/v1/followup_settings?id=eq.1`, {
    method: 'PATCH', headers: { ...hdrJson(), Prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return (await r.json())[0] || null;
}
export async function fetchFollowupLog(leadId) {
  try {
    return (await sbSelect(`followup_log?lead_id=eq.${leadId}&select=step,sent_at,to_email,test_mode,error&order=sent_at.desc&limit=20`)) || [];
  } catch { return []; }
}
export async function countActiveFollowups() {
  try { return ((await sbSelect('leads?followup_status=eq.active&select=id')) || []).length; }
  catch { return 0; }
}
```

- [ ] **Step 3: `useLeads.js` — normalise the fields**

In `normaliseRecord`, replace:

```js
    invoiceSent: !!f['Invoice Sent'],
    airtableId: rec.id,
```

with:

```js
    invoiceSent: !!f['Invoice Sent'],
    quoteSentAt: f['Quote Sent At'] || null,
    followupStatus: f['Follow-up Status'] || null,
    followupStep: Number(f['Follow-up Step']) || 0,
    followupNextAt: f['Follow-up Next At'] || null,
    followupStopReason: f['Follow-up Stop Reason'] || null,
    airtableId: rec.id,
```

- [ ] **Step 4: `useLeads.js` — Start/Stop actions**

Insert directly above the final `return {` of `useLeads` (just after `permanentDeleteClient`):

```js
  // ─── Quote follow-ups: manual Start/Resume + Stop (Supabase only — these
  //     columns don't exist in Airtable, and an unknown field would fail the PATCH).
  const setFollowupState = useCallback(async (leadId, fields, local) => {
    const lead = leads.find(l => l.id === leadId);
    if (!USE_SUPABASE || !lead?.airtableId) return false;
    setLeads(prev => prev.map(l => (l.id === leadId ? { ...l, ...local } : l)));
    const res = await patchAirtable(lead.airtableId, fields);
    if (res && res.__patchFailed) {
      const revert = Object.fromEntries(Object.keys(local).map(k => [k, lead[k]]));
      setLeads(prev => prev.map(l => (l.id === leadId ? { ...l, ...revert } : l)));
      return false;
    }
    return true;
  }, [leads, patchAirtable]);

  // Start (never enrolled → step 0) or Resume (keeps its step). The next step
  // goes out at the next check inside the send window.
  const startFollowups = useCallback(leadId => {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return Promise.resolve(false);
    const step = lead.followupStatus ? lead.followupStep : 0;
    const nowIso = new Date().toISOString();
    const quoteSentAt = lead.quoteSentAt || nowIso; // reply check counts replies from here
    return setFollowupState(leadId,
      { 'Follow-up Status': 'active', 'Follow-up Step': step, 'Follow-up Next At': nowIso,
        'Follow-up Fail Count': 0, 'Follow-up Stop Reason': null, 'Quote Sent At': quoteSentAt },
      { followupStatus: 'active', followupStep: step, followupNextAt: nowIso, followupStopReason: null, quoteSentAt });
  }, [leads, setFollowupState]);

  const stopFollowups = useCallback(leadId => setFollowupState(leadId,
    { 'Follow-up Status': 'stopped', 'Follow-up Stop Reason': 'manual', 'Follow-up Next At': null },
    { followupStatus: 'stopped', followupStopReason: 'manual', followupNextAt: null }), [setFollowupState]);
```

In the returned object, replace:

```js
    archivedClients, archiveClient, restoreClient, permanentDeleteClient,
  };
}
```

with:

```js
    archivedClients, archiveClient, restoreClient, permanentDeleteClient,
    startFollowups, stopFollowups,
  };
}
```

- [ ] **Step 5: `LeadsContext.jsx` — load settings and expose everything**

Add after `import { updateRecord, AT_TABLES } from '../utils/airtableSync';`:

```js
import { USE_SUPABASE, fetchFollowupSettings } from '../utils/supabaseClient';
```

In the `useLeads(technician)` destructure, replace:

```js
    archivedClients, archiveClient, restoreClient, permanentDeleteClient,
  } = useLeads(technician);
```

with:

```js
    archivedClients, archiveClient, restoreClient, permanentDeleteClient,
    startFollowups, stopFollowups,
  } = useLeads(technician);

  // Quote follow-up settings (owner + Supabase only). null = not set up on this
  // branch / technician → all follow-up UI stays hidden.
  const [followupSettings, setFollowupSettings] = useState(null);
  useEffect(() => {
    if (readOnly || !USE_SUPABASE) return;
    fetchFollowupSettings().then(setFollowupSettings);
  }, [readOnly]);
```

In the provider `value`, replace:

```js
      permanentDeleteClient,
      refetch: fetchLeads,
```

with:

```js
      permanentDeleteClient,
      followupSettings,
      setFollowupSettings,
      startFollowups,
      stopFollowups,
      refetch: fetchLeads,
```

- [ ] **Step 6: Refusal code `no_response`**

`src/utils/constants.js` — replace:

```js
  no_answer:     'No Answer',
  other:         'Other',
};
```

with:

```js
  no_answer:     'No Answer',
  no_response:   'No Response to Follow-ups',
  other:         'Other',
};
```

`src/components/StatsRow.jsx` — replace:

```js
  const rc = { too_expensive: 0, competition: 0, no_answer: 0, other: 0 };
```

with:

```js
  const rc = { too_expensive: 0, competition: 0, no_answer: 0, no_response: 0, other: 0 };
```

and replace:

```js
  if (rc.no_answer)     refuseParts.push(`${rc.no_answer} no answer`);
```

with:

```js
  if (rc.no_answer)     refuseParts.push(`${rc.no_answer} no answer`);
  if (rc.no_response)   refuseParts.push(`${rc.no_response} no response`);
```

`src/components/DetailPanel.jsx` — replace:

```js
                const emoji = key === 'too_expensive' ? '💰 ' : key === 'competition' ? '🏆 ' : key === 'no_answer' ? '📵 ' : '❓ ';
```

with:

```js
                const emoji = key === 'too_expensive' ? '💰 ' : key === 'competition' ? '🏆 ' : key === 'no_answer' ? '📵 ' : key === 'no_response' ? '📭 ' : '❓ ';
```

- [ ] **Step 7: Verify the build and helper tests**

Run: `npm run build && node execution/test_followup_template.mjs`
Expected: Vite build succeeds with no errors; `PASS — followupTemplate`.

- [ ] **Step 8: Commit**

```bash
git add src/utils/supabaseClient.js src/hooks/useLeads.js src/context/LeadsContext.jsx src/utils/constants.js src/components/StatsRow.jsx src/components/DetailPanel.jsx
git commit -m "feat(followups): wire follow-up fields, settings + start/stop actions into the dashboard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Settings page

**Files:**
- Create: `src/components/pages/SettingsPage.jsx`
- Modify: `src/App.jsx` (import + `case 'settings'`)
- Modify: `src/components/Sidebar.jsx` (`PAGE_TITLES.settings` + nav item)
- Create (disposable, gitignored): `.tmp/shot-followups.cjs`

**Interfaces:**
- Consumes: context `followupSettings`, `setFollowupSettings`, `showToast`; `saveFollowupSettings`, `countActiveFollowups`, `USE_SUPABASE` (Task 7); `DEFAULT_STEPS`, `PLACEHOLDERS`, `STEP_WAIT_LABELS`, `renderTemplate`, `sampleContext`, `validateSettings` (Task 6).
- Produces: page key `'settings'`.

- [ ] **Step 1: Create the page**

Create `src/components/pages/SettingsPage.jsx`:

```jsx
// Settings → Quote Follow-ups (owner only). Edits the single followup_settings
// row that the Cloud Run job (whatsapp-service/followup.js) reads every 15 min.
// The preview uses the same template rules as the sender (followupTemplate.js).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import { USE_SUPABASE, saveFollowupSettings, countActiveFollowups } from '../../utils/supabaseClient';
import { DEFAULT_STEPS, PLACEHOLDERS, STEP_WAIT_LABELS, renderTemplate, sampleContext, validateSettings } from '../../utils/followupTemplate';

const card  = { background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '16px', marginBottom: '12px' };
const lbl   = { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: '6px' };
const field = { width: '100%', padding: '9px 11px', fontSize: '14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', boxSizing: 'border-box', background: '#fff', color: 'var(--gray-900)' };
const row   = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' };
const title = { fontSize: '14px', fontWeight: 700, color: 'var(--gray-900)' };
const hourLabel = h => (h === 0 || h === 24 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`);

function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={() => onChange(!on)}
      style={{ width: '44px', height: '26px', borderRadius: '13px', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, background: on ? 'var(--primary)' : 'var(--gray-300)', transition: 'background .15s' }}
    >
      <span style={{ position: 'absolute', top: '3px', left: on ? '21px' : '3px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .15s' }} />
    </button>
  );
}

function StepCard({ index, step, ctx, onChange }) {
  const bodyRef = useRef(null);
  const [unit, setUnit] = useState(step.delay_hours % 24 === 0 ? 'days' : 'hours');
  const amount = unit === 'days' ? step.delay_hours / 24 : step.delay_hours;
  const set = patch => onChange({ ...step, ...patch });

  function setAmount(v) {
    const n = parseFloat(v);
    set({ delay_hours: Number.isFinite(n) ? Math.round(n * (unit === 'days' ? 24 : 1)) : 0 });
  }

  function insertPlaceholder(key) {
    const token = `{${key}}`;
    const el = bodyRef.current;
    if (!el) { set({ body: `${step.body}${token}` }); return; }
    const a = el.selectionStart ?? step.body.length;
    const b = el.selectionEnd ?? a;
    set({ body: step.body.slice(0, a) + token + step.body.slice(b) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  }

  return (
    <div style={{ ...card, opacity: step.enabled ? 1 : 0.65 }}>
      <div style={{ ...row, marginBottom: '12px' }}>
        <div>
          <div style={title}>Follow-up {index + 1}{index === 2 ? ' — final' : ''}</div>
          {index === 2 && <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>After this one sends, the lead moves to Refused.</div>}
        </div>
        <Toggle on={step.enabled} onChange={v => set({ enabled: v })} label={`Follow-up ${index + 1} on/off`} />
      </div>

      <label style={lbl}>When</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input type="number" min="1" step="1" value={amount} onChange={e => setAmount(e.target.value)} style={{ ...field, width: '80px' }} />
        <select value={unit} onChange={e => setUnit(e.target.value)} style={{ ...field, width: 'auto' }}>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <span style={{ fontSize: '13px', color: 'var(--gray-600)' }}>{STEP_WAIT_LABELS[index]}</span>
      </div>

      <label style={lbl}>Subject</label>
      <input value={step.subject} onChange={e => set({ subject: e.target.value })} style={{ ...field, marginBottom: '12px' }} />

      <label style={lbl}>Message</label>
      <textarea ref={bodyRef} rows={9} value={step.body} onChange={e => set({ body: e.target.value })} style={{ ...field, resize: 'vertical', lineHeight: 1.5 }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0 12px' }}>
        {PLACEHOLDERS.map(p => (
          <button
            key={p.key} type="button" onClick={() => insertPlaceholder(p.key)}
            style={{ fontSize: '11.5px', fontWeight: 600, padding: '5px 10px', borderRadius: '20px', border: '1px solid var(--gray-200)', background: 'var(--gray-50)', color: 'var(--gray-600)', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            + {p.label}
          </button>
        ))}
      </div>

      <label style={lbl}>Preview</label>
      <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: '8px', padding: '12px', fontSize: '13px', color: 'var(--gray-800)', lineHeight: 1.55 }}>
        <div style={{ fontWeight: 700, marginBottom: '8px' }}>{renderTemplate(step.subject, ctx)}</div>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderTemplate(step.body, ctx)}</div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { followupSettings, setFollowupSettings, showToast } = useLeadsContext();
  const [draft, setDraft] = useState(followupSettings);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [activeCount, setActiveCount] = useState(null);

  useEffect(() => { setDraft(followupSettings); setErrors([]); }, [followupSettings]);
  useEffect(() => { if (followupSettings) countActiveFollowups().then(setActiveCount); }, [followupSettings]);

  const ctx = useMemo(() => sampleContext(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(followupSettings);

  const header = (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Quote Follow-ups</div>
      <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>
        Automatic emails to customers who were sent a quote but haven't replied.
      </div>
    </div>
  );

  if (!USE_SUPABASE || !draft) {
    return (
      <div className="page">
        {header}
        <div style={card}><div style={{ fontSize: '14px', color: 'var(--gray-600)' }}>Follow-ups aren't set up for this branch yet.</div></div>
      </div>
    );
  }

  const set = patch => setDraft(d => ({ ...d, ...patch }));
  const setStep = (i, step) => setDraft(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? step : s)) }));

  async function save() {
    const errs = validateSettings(draft);
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    try {
      const { id, updated_at, ...patch } = draft;
      const saved = await saveFollowupSettings(patch);
      if (saved) setFollowupSettings(saved);
      showToast('Follow-up settings saved');
    } catch (e) {
      showToast(`Save failed — ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const canSave = dirty && !saving;

  return (
    <div className="page" style={{ maxWidth: '760px' }}>
      {header}

      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>Automatic follow-ups</div>
            <div style={{ fontSize: '12.5px', color: 'var(--gray-500)', marginTop: '2px' }}>
              {draft.enabled
                ? `On — ${activeCount ?? '…'} lead${activeCount === 1 ? '' : 's'} in a sequence · checked every 15 min`
                : 'Off — no follow-up emails are sent and new quotes are not enrolled.'}
            </div>
          </div>
          <Toggle on={draft.enabled} onChange={v => set({ enabled: v })} label="Automatic follow-ups on/off" />
        </div>
      </div>

      <div style={{ ...card, ...(draft.test_mode ? { background: '#fffbeb', borderColor: '#fde68a' } : {}) }}>
        <div style={row}>
          <div>
            <div style={title}>Test mode</div>
            <div style={{ fontSize: '12.5px', color: draft.test_mode ? '#92400e' : 'var(--gray-500)', marginTop: '2px' }}>
              {draft.test_mode
                ? 'Only leads whose name starts with TEST are emailed — and only to the test address below. Real leads are held.'
                : 'Off — follow-ups go to real customers.'}
            </div>
          </div>
          <Toggle on={draft.test_mode} onChange={v => set({ test_mode: v })} label="Test mode on/off" />
        </div>
        {draft.test_mode && (
          <div style={{ marginTop: '12px' }}>
            <label style={lbl}>Send test emails to</label>
            <input type="email" value={draft.test_email || ''} placeholder="you@example.com" onChange={e => set({ test_email: e.target.value })} style={field} />
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div>
            <label style={lbl}>Signature (sign-off)</label>
            <input value={draft.sender_name || ''} onChange={e => set({ sender_name: e.target.value })} style={field} />
          </div>
          <div>
            <label style={lbl}>Company name</label>
            <input value={draft.company_name || ''} onChange={e => set({ company_name: e.target.value })} style={field} />
          </div>
        </div>
        <label style={{ ...lbl, marginTop: '12px' }}>Only send between</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <select value={draft.window_start_hour} onChange={e => set({ window_start_hour: parseInt(e.target.value, 10) })} style={{ ...field, width: 'auto' }}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span style={{ fontSize: '13px', color: 'var(--gray-600)' }}>and</span>
          <select value={draft.window_end_hour} onChange={e => set({ window_end_hour: parseInt(e.target.value, 10) })} style={{ ...field, width: 'auto' }}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
      </div>

      {(draft.steps || []).map((step, i) => (
        <StepCard key={i} index={i} step={step} ctx={ctx} onChange={s => setStep(i, s)} />
      ))}

      {errors.length > 0 && (
        <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontSize: '13px' }}>
          {errors.map(e => <div key={e}>• {e}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <button
          onClick={save} disabled={!canSave}
          style={{ flex: '1 1 200px', minHeight: '44px', background: canSave ? 'var(--primary)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700, cursor: canSave ? 'pointer' : 'default', fontFamily: 'inherit' }}
        >
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button
          onClick={() => set({ steps: DEFAULT_STEPS.map(s => ({ ...s })) })}
          style={{ minHeight: '44px', padding: '0 16px', background: '#fff', color: 'var(--gray-600)', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Reset to default scripts
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Route + nav**

`src/App.jsx` — add after `import BroadcastPage from './components/pages/BroadcastPage';`:

```js
import SettingsPage from './components/pages/SettingsPage';
```

and replace:

```js
    case 'broadcast':       return <BroadcastPage />;
```

with:

```js
    case 'broadcast':       return <BroadcastPage />;
    case 'settings':        return <SettingsPage />;
```

`src/components/Sidebar.jsx` — replace:

```js
  broadcast:        'Broadcast SMS',
};
```

with:

```js
  broadcast:        'Broadcast SMS',
  settings:         'Settings',
};
```

and directly after the `{!readOnly && navItem('broadcast', 'Broadcast SMS', … )}` block (before `</nav>`), insert:

```jsx
          {!readOnly && navItem('settings', 'Settings',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          )}
```

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds, no errors.

- [ ] **Step 4: Screenshot loop**

Create `.tmp/shot-followups.cjs` (disposable, gitignored):

```js
// Usage: PV_USER=pearlview PV_PASS='…' node .tmp/shot-followups.cjs <page:settings|leads> [leadName]
let pw; try { pw = require('playwright'); } catch { pw = require('C:/Users/User/Desktop/BannerScrapper/node_modules/playwright'); }
(async () => {
  const [page = 'settings', leadName] = process.argv.slice(2);
  const b = await pw.chromium.launch();
  const p = await b.newPage({ viewport: { width: 1366, height: 900 } });
  await p.goto('http://localhost:5173');
  await p.fill('input[autocomplete="username"]', process.env.PV_USER);
  await p.fill('input[type="password"]', process.env.PV_PASS);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(7000);
  if (page === 'settings') await p.click('.nav-item:has-text("Settings")');
  if (leadName) await p.getByText(leadName).first().click();
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `.tmp/screenshots/${page}-desktop.png`, fullPage: true });
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(800);
  await p.screenshot({ path: `.tmp/screenshots/${page}-mobile.png`, fullPage: true });
  await b.close();
})();
```

Start `npm run dev` in the background (port 5173). Run `PV_USER=pearlview PV_PASS='<owner password from memory>' node .tmp/shot-followups.cjs settings`. Read both PNGs. Check: header, master/test-mode toggles, amber test-mode card, signature/company/window card, 3 step cards with chips + preview showing "Hi Sarah," and the signature, Save/Reset row; mobile at 390px with no horizontal scroll. Fix issues, re-shoot, then delete everything in `.tmp/screenshots/`.

- [ ] **Step 5: Functional check (don't leave state changed)**

In the running app (test mode is ON by default and the test email is blank): change Follow-up 1 to 2 hours → "Save changes" enables → Save → the error box shows "Test mode needs a valid test email address." and nothing is saved. Enter John's address as the test email → Save → toast "Follow-up settings saved". Then **restore** Follow-up 1 to 2 days (48 h) and Save (keep the test email — it's needed for acceptance). Confirm:
```bash
node --env-file=.env -e "fetch(process.env.SUPABASE_URL+'/rest/v1/followup_settings?id=eq.1&select=enabled,test_mode,steps',{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE}}).then(r=>r.json()).then(d=>console.log(d[0].enabled,d[0].test_mode,d[0].steps.map(s=>s.delay_hours)))"
```
Expected: `false true [ 48, 72, 120 ]`.

- [ ] **Step 6: Commit**

```bash
git add src/components/pages/SettingsPage.jsx src/App.jsx src/components/Sidebar.jsx
git commit -m "feat(followups): owner Settings page for quote follow-ups

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Tick PMS** with `"Settings page"`.

---

### Task 9: Lead panel follow-up block + card chip

**Files:**
- Create: `src/components/FollowupSection.jsx`
- Modify: `src/components/DetailPanel.jsx` (import + render before the Payment section)
- Modify: `src/components/LeadCard.jsx` (import, context, chip)

**Interfaces:**
- Consumes: context `followupSettings`, `startFollowups`, `stopFollowups`, `showToast`, `readOnly`; `fetchFollowupLog` (Task 7); `describeFollowup`, `followupChip` (Task 6).
- Produces: `<FollowupSection lead={lead} />`.

- [ ] **Step 1: Create the section**

Create `src/components/FollowupSection.jsx`:

```jsx
// Quote follow-up status, send history and Stop/Start inside the lead detail
// panel (owner only). Status text + which button to show come from
// describeFollowup() so the rules stay unit-tested.
import { useEffect, useState } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import { fetchFollowupLog } from '../utils/supabaseClient';
import { describeFollowup } from '../utils/followupTemplate';

const TONES = {
  info:  { bg: '#f5f3ff', border: '#ddd6fe', color: '#5b21b6' },
  ok:    { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d' },
  warn:  { bg: '#fffbeb', border: '#fde68a', color: '#92400e' },
  muted: { bg: 'var(--gray-50)', border: 'var(--gray-200)', color: 'var(--gray-600)' },
};
const LABELS = { stop: 'Stop follow-ups', start: 'Start follow-ups', resume: 'Resume follow-ups' };
const fmt = iso => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function FollowupSection({ lead }) {
  const { followupSettings, startFollowups, stopFollowups, showToast } = useLeadsContext();
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLog([]);
    if (lead?.airtableId && followupSettings) fetchFollowupLog(lead.airtableId).then(rows => { if (alive) setLog(rows); });
    return () => { alive = false; };
  }, [lead?.airtableId, lead?.followupStep, lead?.followupStatus, followupSettings]);

  const info = describeFollowup(lead, followupSettings);
  if (!info) return null;
  const t = TONES[info.tone] || TONES.muted;
  const isStop = info.action === 'stop';

  async function act() {
    setBusy(true);
    const ok = isStop ? await stopFollowups(lead.id) : await startFollowups(lead.id);
    setBusy(false);
    showToast(!ok ? 'Could not update follow-ups — try again'
      : isStop ? 'Follow-ups stopped' : 'Follow-ups on — the next email goes at the next check');
  }

  return (
    <div className="psec">
      <div className="psec-title">Quote Follow-ups</div>
      <div style={{ background: t.bg, border: `1.5px solid ${t.border}`, borderRadius: '10px', padding: '10px 12px', fontSize: '12.5px', fontWeight: 600, color: t.color, lineHeight: 1.45 }}>
        {info.text}
      </div>
      {log.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {log.map((r, i) => (
            <div key={i} style={{ fontSize: '11.5px', color: r.error ? '#b91c1c' : 'var(--gray-600)', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <strong>FU{r.step}</strong>
              <span>{fmt(r.sent_at)}</span>
              <span style={{ wordBreak: 'break-all' }}>{r.error ? `failed: ${r.error}` : `→ ${r.to_email}`}</span>
              {r.test_mode && <span style={{ fontWeight: 700, color: '#92400e' }}>TEST</span>}
            </div>
          ))}
        </div>
      )}
      {info.action && (
        <button
          onClick={act} disabled={busy}
          style={{ marginTop: '10px', width: '100%', minHeight: '44px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, fontFamily: 'inherit', cursor: busy ? 'default' : 'pointer',
            background: isStop ? '#fff' : 'var(--primary)', color: isStop ? '#b91c1c' : '#fff', border: isStop ? '1.5px solid #fecaca' : 'none' }}
        >
          {busy ? 'Saving…' : LABELS[info.action]}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Render it in `DetailPanel.jsx`**

Add after `import { REFUSE_LABELS } from '../utils/constants';`:

```js
import FollowupSection from './FollowupSection';
```

Replace:

```jsx
        {/* Payment (owner only — money is hidden for read-only technicians) */}
```

with:

```jsx
        {/* Quote follow-ups (owner only; renders nothing unless relevant) */}
        {!readOnly && <FollowupSection lead={l} />}

        {/* Payment (owner only — money is hidden for read-only technicians) */}
```

- [ ] **Step 3: Chip on `LeadCard.jsx`**

Add after `import { REFUSE_LABELS, COLS } from '../utils/constants';`:

```js
import { followupChip } from '../utils/followupTemplate';
```

Replace:

```js
    renameLead, showToast, readOnly,
  } = useLeadsContext();
```

with:

```js
    renameLead, showToast, readOnly, followupSettings,
  } = useLeadsContext();
  const fuChip = readOnly ? null : followupChip(lead, followupSettings);
```

Replace:

```jsx
        {(age || isOverdue) && (
```

with:

```jsx
        {(age || isOverdue || fuChip) && (
```

and directly after the `{isOverdue && ( … 📅 Follow Up Due … )}` span block (still inside that badges `<div>`), insert:

```jsx
            {fuChip && (
              <span style={{ fontSize: '9.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px', background: fuChip.bg, color: fuChip.color }}>
                ✉ {fuChip.label}
              </span>
            )}
```

- [ ] **Step 4: Build + tests**

Run: `npm run build && node execution/test_followup_template.mjs`
Expected: build succeeds; `PASS — followupTemplate`.

- [ ] **Step 5: Screenshot loop with a dummy lead**

Create a temporary Quote Sent lead (feature is off → panel shows "Automatic follow-ups are off — turn them on in Settings." + Start button):
```bash
node --env-file=.env -e "fetch(process.env.SUPABASE_URL+'/rest/v1/leads',{method:'POST',headers:{apikey:process.env.SUPABASE_SERVICE_ROLE,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({client_name:'TEST Panel Check',email:'panel-check@example.com',lead_status:'Quote Sent',quote_amount:350})}).then(r=>r.json()).then(d=>console.log(d[0].id,d[0].followup_status))"
```
With `npm run dev` running: `PV_USER=pearlview PV_PASS='…' node .tmp/shot-followups.cjs leads "TEST Panel Check"`. Read the PNGs: the panel shows a "Quote Follow-ups" section above Payment with the muted text and a green "Start follow-ups" button (44px tall); no layout breakage at 390px. Click **Start follow-ups** in the running app → toast → card shows `✉ FU 0/3`, panel shows "Follow-up 1 of 3 goes out at the next check." + red-outlined "Stop follow-ups". Click Stop → `✉ FU stopped`. Fix issues, re-shoot. Then delete the lead and all screenshots:
```bash
node --env-file=.env -e "fetch(process.env.SUPABASE_URL+'/rest/v1/leads?client_name=eq.TEST%20Panel%20Check',{method:'DELETE',headers:{apikey:process.env.SUPABASE_SERVICE_ROLE,Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE}}).then(r=>console.log('deleted',r.status))"
rm -f .tmp/screenshots/*
```
(The feature is off, so the backend never emails this lead.)

- [ ] **Step 6: Commit**

```bash
git add src/components/FollowupSection.jsx src/components/DetailPanel.jsx src/components/LeadCard.jsx
git commit -m "feat(followups): lead panel follow-up block + Kanban card chip

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Tick PMS** with `"Lead panel"`.

---

### Task 10: Rollout + acceptance (user-gated)

**Files:** none new (ops). Memory + PMS updates at the end.

**Interfaces:**
- Consumes: everything above. Live service URL `https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app`.

- [ ] **Step 1: Full test sweep**

Run: `cd whatsapp-service && node --test followup-core.test.js followup.test.js && cd .. && node execution/test_followup_template.mjs && npm run build`
Expected: 34 backend tests PASS, `PASS — followupTemplate`, build OK.

- [ ] **Step 2: Generate the cron secret**

Run: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` → append `CRON_SECRET=<value>` to `whatsapp-service/.env` (gitignored — confirm with `git check-ignore whatsapp-service/.env`). Never commit it.

- [ ] **Step 3: Deploy Cloud Run (user logs in first)**

Read memories [[project_gcp_org_policy]] and [[feedback_gcloud_auth]]. Ask the user to run, in their own PowerShell:
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$env:CLOUDSDK_PYTHON="C:\Users\User\AppData\Local\Python\bin\python3.exe"
gcloud auth login sandbox@optinetsolutions.com
```
**Wait for "You are now logged in".** Then:
```bash
export CLOUDSDK_PYTHON="C:/Users/User/AppData/Local/Python/bin/python3.exe"
cd whatsapp-service
gcloud run deploy pearl-view-whatsapp --source . --region asia-southeast1 --project pearl-view-491114 \
  --clear-base-image --update-env-vars "CRON_SECRET=<value>"
```
Expected: new revision serving 100% traffic.

- [ ] **Step 4: Live dry run**

```bash
curl -s -X POST "https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app/run-followups?dry=true" -H "x-cron-secret: <value>"
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app/run-followups"
```
Expected: `{"success":true,"result":{"dry":true,"enabled":false,"testMode":true,…,"due":0,…,"actions":[]}}` (nothing enrolled yet), then `401`.

- [ ] **Step 5: Create the Cloud Scheduler job**

First mirror the existing extractor job's location: `gcloud scheduler jobs list --project pearl-view-491114 --location asia-southeast1`. Then:
```bash
gcloud scheduler jobs create http pearl-view-followups --project pearl-view-491114 --location asia-southeast1 \
  --schedule "*/15 * * * *" --time-zone "Australia/Sydney" \
  --uri "https://pearl-view-whatsapp-612999767286.asia-southeast1.run.app/run-followups" \
  --http-method POST --headers "x-cron-secret=<value>" --attempt-deadline 300s
gcloud scheduler jobs run pearl-view-followups --project pearl-view-491114 --location asia-southeast1
```
Check Cloud Run logs for the run: expect a 200 with `"skipped":"disabled"`.

- [ ] **Step 6: Local review → push (explicit approval only)**

`npm run dev`, tell the user it's ready to review (Settings page + a Quote Sent lead panel). **Wait for "push it".** Then:
```bash
git push origin main
```
(Prod auto-deploys from `main`. Do not run `vercel --prod`.) Tick PMS `"Deploy:"`.

- [ ] **Step 7: Dummy-lead acceptance run (with the user)**

In prod Settings: follow-ups **ON**, test mode **ON**, test email = John's address, all three delays **1 hour**, Save. Create in the dashboard and move each to Quote Sent:
| Lead | Email | Action | Expected |
|---|---|---|---|
| `TEST Full Run` | any (e.g. `fullrun@example.com`) | wait | FU1/FU2/FU3 arrive at the test inbox ~hourly (subject `[TEST → fullrun@example.com] …`), then lead → Refused "No Response to Follow-ups" |
| `TEST Reply` | an address the user controls | after FU1, reply from that address **to service@pearlview.com.au** | status Replied, chip `Replied`, owner WhatsApp alert, no FU2 |
| `TEST Booked` | any | after FU1, move to Booked | panel "Follow-ups stopped (status changed)", no FU2 |
| `TEST Manual` | any | click Stop | `FU stopped`, nothing further |
| `TEST No Email` | none | add an email later | `No email` chip, nothing sent → becomes active after email added |

Any real lead quoted meanwhile must receive nothing: its card shows `✉ Held` and its panel says "Held — test mode is on…". (The job doesn't even fetch it — in test mode it only selects `TEST…` leads.)

- [ ] **Step 8: Extractor-guard live check**

Temporarily set the test email to `service@pearlview.com.au`, create `TEST Guard` (any email) → wait for FU1 to land in the service@ inbox → run `curl -s -X POST "<service>/extract-emails?notify=false"` → Cloud Run logs show `Skipping own follow-up email`, and no new lead appears. Set the test email back to John's.

- [ ] **Step 9: Go live**

Delete all `TEST …` leads; set delays back to **2 / 3 / 5 days**; turn **test mode OFF**; Save. Tick PMS `"Dummy-lead acceptance"`; move the PMS task to Done:
```bash
node --env-file=.env -e "fetch(process.env.PMS_BASE_URL+'/api/tasks/cmv15gvlc002n04l53rm9rcr2/move',{method:'PATCH',headers:{Authorization:'Bearer '+process.env.PMS_API_TOKEN,'Content-Type':'application/json'},body:JSON.stringify({columnId:'cmq5b01vp000604jm34ltg2iz',position:0})}).then(r=>console.log(r.status))"
```

- [ ] **Step 10: Record what was learned**

Update memory (new `project_quote_followups.md` + `MEMORY.md` pointer): endpoint, scheduler job name, secret location, test-mode rule, refusal code `no_response`, settings table. Ask the user whether to add a `/run-followups` row to the CLAUDE.md endpoints table.
