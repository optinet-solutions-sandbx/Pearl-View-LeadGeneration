import { useState } from 'react';
import { signIn } from '../utils/supabaseClient';

// Username + password login gate (Phase 7). The username maps to a hidden
// Supabase Auth email; the logged-in session token then authorises all DB
// access under RLS.
export default function LoginPage({ onSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (!username || !password) { setErr('Enter your username and password.'); return; }
    setErr(''); setBusy(true);
    const res = await signIn(username, password);
    setBusy(false);
    if (res.ok) onSuccess();
    else setErr(res.error || 'Login failed.');
  }

  const wrap = { minHeight: '100vh', background: '#0b1220', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', fontFamily: 'Arial, Helvetica, sans-serif' };
  const card = { background: '#fff', borderRadius: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.35)', width: '100%', maxWidth: '380px', padding: '34px 30px' };
  const input = { width: '100%', padding: '12px 14px', fontSize: '15px', border: '1.5px solid #d6d9e0', borderRadius: '10px', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: '12px' };
  const lbl = { fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#888', marginBottom: '6px', display: 'block' };

  return (
    <div style={wrap}>
      <form style={card} onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <div style={{ width: '34px', height: '34px', borderRadius: '9px', background: '#0f766e', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: '15px' }}>PV</div>
          <div style={{ fontSize: '18px', fontWeight: 800, color: '#2f3a8f' }}>Pearl View</div>
        </div>
        <div style={{ fontSize: '14px', color: '#666', margin: '4px 0 22px' }}>Lead Management — sign in to continue</div>

        <label style={lbl}>Username</label>
        <input style={input} value={username} onChange={e => setUsername(e.target.value)} autoFocus autoComplete="username" placeholder="username" />
        <label style={lbl}>Password</label>
        <input style={input} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" placeholder="••••••••" />

        {err && <div style={{ color: '#dc2626', fontSize: '13px', margin: '2px 0 12px' }}>{err}</div>}

        <button type="submit" disabled={busy} style={{ width: '100%', padding: '13px', background: busy ? '#9ca3af' : '#0f766e', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '15px', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', marginTop: '4px' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
