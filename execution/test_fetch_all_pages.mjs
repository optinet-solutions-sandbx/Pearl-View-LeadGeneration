/* Standalone tests for the paged table loader.
   Run: node execution/test_fetch_all_pages.mjs   (exit 0 = pass)
   Regression: PostgREST caps every response at the project's max_rows (1000);
   the dashboard read leads in ONE request, so once there were 1103 leads,
   103 silently vanished from the board (2026-10-22). */
import assert from 'node:assert/strict';
import { fetchAllPages } from '../src/utils/fetchAllPages.js';

// Fake PostgREST: `total` rows, never returns more than `serverCap` per request.
function fakeSource(total, serverCap) {
  const rows = Array.from({ length: total }, (_, i) => ({ id: i }));
  const calls = [];
  const fetchPage = async (offset, limit) => {
    calls.push({ offset, limit });
    return rows.slice(offset, offset + Math.min(limit, serverCap));
  };
  return { fetchPage, calls };
}

const ids = list => list.map(r => r.id);
const range = n => Array.from({ length: n }, (_, i) => i);

// more rows than one page → all of them, in order, no duplicates
let s = fakeSource(2503, 1000);
assert.deepEqual(ids(await fetchAllPages(s.fetchPage, 1000)), range(2503));

// server cap BELOW the page size (the 1000-row cliff) → still complete
s = fakeSource(1103, 700);
assert.deepEqual(ids(await fetchAllPages(s.fetchPage, 1000)), range(1103), 'server cap below page size must not truncate');

// exactly one full page → complete, stops on the following empty page
s = fakeSource(1000, 1000);
assert.equal((await fetchAllPages(s.fetchPage, 1000)).length, 1000);
assert.deepEqual(s.calls.map(c => c.offset), [0, 1000]);

// empty table → [] after a single request
s = fakeSource(0, 1000);
assert.deepEqual(await fetchAllPages(s.fetchPage, 1000), []);
assert.equal(s.calls.length, 1);

// default page size is 1000
s = fakeSource(5, 1000);
await fetchAllPages(s.fetchPage);
assert.equal(s.calls[0].limit, 1000);

console.log('PASS — fetchAllPages');
