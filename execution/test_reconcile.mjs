/* Standalone tests for the pure linkage core.
   Run: node execution/test_reconcile.mjs   (exit 0 = pass) */
import assert from 'node:assert';
import { findLinked, computeReconcile } from '../src/utils/reconcile.js';

// ── findLinked ────────────────────────────────────────────────────────────
const recs = [
  { leadId: 'L1', phone: '0400 111 222', name: 'Bailey' },
  { leadId: null, phone: '0400 999 888', name: 'Amira' },
  { leadId: null, phone: '',             name: 'Tania' },
];
assert.strictEqual(findLinked(recs, { leadId: 'L1' }).name, 'Bailey', 'lead_id wins');
assert.strictEqual(findLinked(recs, { phone: '0400999888' }).name, 'Amira', 'phone match (digits)');
assert.strictEqual(findLinked(recs, { name: 'tania' }).name, 'Tania', 'name match when caller has no phone');
assert.strictEqual(findLinked(recs, { phone: '0400111222', name: 'Amira' }).name, 'Bailey', 'phone beats name');
assert.strictEqual(findLinked(recs, { name: 'nobody' }), null, 'no match → null');
// a caller WITH a phone must not fall back to name
assert.strictEqual(findLinked(recs, { phone: '0400000000', name: 'Tania' }), null, 'phone present but unmatched → no name fallback');

// ── computeReconcile: booking status follows lead status ────────────────────
const bk = (bookingStatus, amount) => ({ bookingStatus, amount });
// booked + Scheduled + amount already equal → no change (idempotent)
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'booked' }, booking: bk('Scheduled', 300), revenue: { amount: 300, status: 'In Progress' } }),
  { bookingPatch: null, revenuePatch: null }, 'idempotent when consistent');
// job_done → Scheduled booking becomes Completed
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'job_done' }, booking: bk('Scheduled', 300), revenue: { amount: 300, status: 'Job Done' } }).bookingPatch,
  { 'Booking Status': 'Completed' }, 'job_done completes a scheduled booking');
// demoted (in_progress) → Scheduled booking becomes Cancelled
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'in_progress' }, booking: bk('Scheduled', 0), revenue: null }).bookingPatch,
  { 'Booking Status': 'Cancelled' }, 'leaving Booked cancels the active booking');
// Bailey: Completed booking, payment differs → amount syncs to revenue, status untouched
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'job_done' }, booking: bk('Completed', 800), revenue: { amount: 300, status: 'Job Done' } }).bookingPatch,
  { 'Amount': 300 }, 'payment wins; completed status is terminal');
// Cancelled booking is terminal — never resurrected even if lead is booked
assert.strictEqual(
  computeReconcile({ lead: { status: 'booked' }, booking: bk('Cancelled', 0), revenue: null }).bookingPatch,
  null, 'cancelled booking is terminal');
// no booking → null booking patch
assert.strictEqual(
  computeReconcile({ lead: { status: 'booked' }, booking: null, revenue: null }).bookingPatch,
  null, 'no booking → no patch');
// revenue status follows lead status
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'job_done' }, booking: null, revenue: { amount: 300, status: 'In Progress' } }).revenuePatch,
  { 'Status': 'Job Done' }, 'job_done sets revenue Job Done');
assert.deepStrictEqual(
  computeReconcile({ lead: { status: 'in_progress' }, booking: null, revenue: { amount: 300, status: 'Job Done' } }).revenuePatch,
  { 'Status': 'In Progress' }, 'non-done sets revenue In Progress');

console.log('PASS: reconcile core');
