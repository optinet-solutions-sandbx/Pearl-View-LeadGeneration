/* Standalone test for the Facebook lead extractor pure helpers.
   Run: node execution/test_fb_extractor.cjs   (exit 0 = pass) */
const assert = require('assert');
const {
  parseCsv, csvToObjects, isTestRow, mapFbRowToLead,
} = require('../whatsapp-service/email-extractor');

// Real sample (header + fb row + ig row + Meta test row) plus one synthetic
// quoted-comma row to prove the parser handles embedded commas.
const SAMPLE = [
  'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,form_name,is_organic,platform,full_name,phone_number,email,inbox_url,lead_status',
  'l:2046983545902460,2026-07-16T00:12:13+03:00,ag:1,מודעת,as:1,13.7,c:1,קמפיין לידים 13.7,f:1,Window Cleaning 13.7,false,fb,Billy French,p:+61402012700,billyfrench0325@gmail.com,https://x,CREATED',
  'l:1075817815004880,2026-07-14T09:55:56+03:00,ag:1,מודעת,as:1,13.7,c:1,קמפיין לידים 13.7,f:1,Window Cleaning 13.7,false,ig,Sze Tye,p:+61409120429,szetye@blacktye.id.au,,CREATED',
  'l:1359317866399979,2026-07-16T03:17:00-05:00,,,,,,,f:1,Window Cleaning 13.7,true,,<test lead: dummy data for full_name>,p:<test lead: dummy data for phone_number>,test@meta.com,<test lead: dummy data for inbox_url>,CREATED',
  'l:555,2026-07-10T10:00:00+10:00,ag:1,ad,as:1,13.7,c:1,Camp,f:1,Window Cleaning 13.7,false,fb,"French, Billy",p:+61400000000,comma@test.com,,CREATED',
].join('\n');

// parseCsv: quoted comma stays one field
const raw = parseCsv(SAMPLE);
assert.strictEqual(raw.length, 5, 'expected header + 4 data rows');
assert.strictEqual(raw[4][12], 'French, Billy', 'quoted comma must be one field');

// csvToObjects: header-keyed
const objs = csvToObjects(SAMPLE);
assert.strictEqual(objs.length, 4, 'expected 4 data objects');
assert.strictEqual(objs[0].full_name, 'Billy French');
assert.strictEqual(objs[0].platform, 'fb');

// isTestRow: only the Meta test row
assert.strictEqual(isTestRow(objs[0]), false);
assert.strictEqual(isTestRow(objs[2]), true, 'meta test row must be flagged');

// mapFbRowToLead: fb row
const fb = mapFbRowToLead(objs[0]);
assert.strictEqual(fb.fbLeadId, 'l:2046983545902460');
assert.strictEqual(fb.fields['Client Name'], 'Billy French');
assert.strictEqual(fb.fields['Phone Number'], '+61402012700', 'p: prefix must be stripped');
assert.strictEqual(fb.fields['Email'], 'billyfrench0325@gmail.com');
assert.strictEqual(fb.fields['Lead Source'], 'Facebook');
assert.strictEqual(fb.fields['Lead Status'], 'New Lead');
assert.strictEqual(fb.fields['FB Lead Id'], 'l:2046983545902460');
assert.ok(/Facebook Lead Ad — Window Cleaning 13\.7/.test(fb.fields['Inquiry Subject/Reason']));
assert.ok(/קמפיין לידים 13\.7/.test(fb.fields['Notes']), 'non-ASCII campaign preserved in notes');
assert.ok(/2026/.test(fb.fields['Inquiry Date']) && /Jul/.test(fb.fields['Inquiry Date']), 'date formatted');

// mapFbRowToLead: ig row → Instagram
const ig = mapFbRowToLead(objs[1]);
assert.strictEqual(ig.fields['Lead Source'], 'Instagram');
assert.ok(/Instagram Lead Ad/.test(ig.fields['Inquiry Subject/Reason']));

console.log('PASS: fb extractor pure helpers');
