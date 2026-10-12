// Unit tests for the pure follow-up logic. Run: node --test followup-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('./followup-core');

test('cleanEmail extracts a bare address from messy input', () => {
  assert.equal(core.cleanEmail('  jane@x.com  '), 'jane@x.com');
  assert.equal(core.cleanEmail('Jane Doe <jane@x.com>'), 'jane@x.com');
  assert.equal(core.cleanEmail('jane​@x.com'), 'jane@x.com');
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
