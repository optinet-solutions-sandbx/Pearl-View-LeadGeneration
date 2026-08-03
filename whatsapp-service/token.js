/**
 * token.js — signed, expiring booking tokens (HMAC-SHA256).
 * Used to build secure rebook links that carry the lead id WITHOUT exposing it:
 * the payload is signed so it can't be forged/tampered, and expires. Shared by
 * invoice.js (sign) and booking.js (verify) — no circular dependency.
 */
const crypto = require('crypto');

const SECRET = () => process.env.BOOK_TOKEN_SECRET || 'pearlview-dev-secret-change-me';
const b64u = buf => Buffer.from(buf).toString('base64url');

function bad(msg) { const e = new Error(msg); e.code = 'BAD_TOKEN'; return e; }

function signToken(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) throw bad('Invalid booking link.');
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET()).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad('This booking link is invalid or has been tampered with.');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { throw bad('Invalid booking link.'); }
  if (payload.exp && Date.now() > payload.exp) throw bad('This booking link has expired — please contact us for a new one.');
  return payload;
}

module.exports = { signToken, verifyToken };
