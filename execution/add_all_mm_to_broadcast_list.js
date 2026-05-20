/**
 * add_all_mm_to_broadcast_list.js
 *
 * One-off cleanup: takes every contact in your Mobile Message account that
 * isn't already in the "Client pearlview" broadcast list and adds it.
 * After this, every contact in your MM database also receives broadcasts.
 *
 * Usage:
 *   node execution/add_all_mm_to_broadcast_list.js
 *   node execution/add_all_mm_to_broadcast_list.js --dry-run
 *
 * Idempotent — MM returns added:false for any contact already in the list.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadEnv() {
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf-8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnv();

const MM_USER    = process.env.MM_USERNAME     || '';
const MM_PASS    = process.env.MM_API_PASSWORD || '';
const MM_LIST_ID = Number(process.env.MM_LIST_ID || 0);
const DRY_RUN    = process.argv.includes('--dry-run');

if (!MM_USER || !MM_PASS || !MM_LIST_ID) {
  console.error('Missing MM env vars in .env');
  process.exit(1);
}

const auth = Buffer.from(`${MM_USER}:${MM_PASS}`).toString('base64');
const HEADERS = {
  Authorization: `Basic ${auth}`,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function paginated(url) {
  const limit = 200;
  let offset = 0;
  const all = [];
  while (true) {
    const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}limit=${limit}&offset=${offset}`, { headers: HEADERS });
    if (!r.ok) throw new Error(`${url} ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const batch = d.results || [];
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

(async () => {
  console.log(DRY_RUN ? '🟡 DRY RUN — no list changes\n' : '🟢 LIVE — adding missing contacts to broadcast list\n');

  console.log('Fetching all MM contacts…');
  const allContacts = await paginated('https://api.mobilemessage.com.au/v1/contacts');
  console.log(`  Total in MM account: ${allContacts.length}`);

  console.log(`Fetching contacts already in list ${MM_LIST_ID}…`);
  const inList = await paginated(`https://api.mobilemessage.com.au/v1/list-contacts?list_id=${MM_LIST_ID}`);
  console.log(`  Already in list: ${inList.length}`);

  const inListPhones = new Set(inList.map(c => String(c.number)));
  const missing = allContacts.filter(c => !inListPhones.has(String(c.number)));
  console.log(`  Missing from list: ${missing.length}\n`);

  if (DRY_RUN) {
    console.log('Sample of contacts that would be added (first 10):');
    missing.slice(0, 10).forEach(c => {
      const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(unnamed)';
      console.log(`  ${c.number}  ${name}`);
    });
    console.log('\nRe-run without --dry-run to add them.');
    return;
  }

  let added = 0, alreadyIn = 0, fail = 0;
  for (let i = 0; i < missing.length; i++) {
    const c = missing[i];
    try {
      const r = await fetch('https://api.mobilemessage.com.au/v1/list-contacts', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ list_id: MM_LIST_ID, number: c.number }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.added === true) {
        added++;
        if ((i + 1) % 25 === 0 || i === missing.length - 1) {
          console.log(`  [${i + 1}/${missing.length}] added ${c.number}`);
        }
      } else if (r.ok && d.added === false) {
        alreadyIn++;
      } else {
        fail++;
        console.log(`  [${i + 1}/${missing.length}] FAIL ${c.number} status=${r.status} ${JSON.stringify(d).slice(0, 80)}`);
      }
    } catch (err) {
      fail++;
      console.log(`  [${i + 1}/${missing.length}] ERR ${c.number}: ${err.message}`);
    }
    // Stay polite: MM allows 5 concurrent, we serialize at ~10/sec.
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\nDone. ${added} added, ${alreadyIn} were already in list, ${fail} failed.`);
})().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
