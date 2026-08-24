/* Provision a technician: Supabase Auth user + profiles row (role=technician).
   Usage: ENV_FILE=whatsapp-service/.env.perth node execution/create_technician.mjs \
            --email tech1@perthview.app --password 'Temp#2026' --name "Zak"
   Reads SUPABASE_URL + SUPABASE_SERVICE_ROLE from ENV_FILE (default .env). */
import { readFileSync } from 'node:fs';

const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : null; };
const email = arg('--email'), password = arg('--password'), name = arg('--name');
if (!email || !password || !name) { console.error('need --email --password --name'); process.exit(1); }

const env = Object.fromEntries(readFileSync(process.env.ENV_FILE || '.env', 'utf8').split(/\r?\n/)
  .filter(l => l.includes('=')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE || env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// 1. create the auth user (email confirmed so they can log in immediately)
const cu = await fetch(`${URL}/auth/v1/admin/users`, { method: 'POST', headers: H,
  body: JSON.stringify({ email, password, email_confirm: true }) });
const user = await cu.json();
const uid = user.id || user.user?.id;
if (!uid) { console.error('create user FAILED:', cu.status, JSON.stringify(user).slice(0, 300)); process.exit(1); }

// 2. profiles row (role=technician)
const cp = await fetch(`${URL}/rest/v1/profiles`, { method: 'POST',
  headers: { ...H, Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({ id: uid, role: 'technician', display_name: name, active: true }) });
console.log(`technician ${name} <${email}> -> ${uid} (profiles ${cp.status})`);
