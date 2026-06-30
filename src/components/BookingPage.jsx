import { useState, useEffect } from 'react';

// Public, login-free rebooking page. Linked from the invoice email as
// /book?t=<signed token>. The token (not a record id) is resolved server-side
// via GET /book-info, which returns the client name, suggested date, and the
// dates already taken (one booking/day → block them). Confirming POSTs to /book.

const BASE =
  import.meta.env.VITE_BOOK_URL ||
  (import.meta.env.VITE_WEBHOOK_URL || '').replace('/notify-lead', '');
const BOOK_URL = BASE ? `${BASE}/book` : '';
const INFO_URL = BASE ? `${BASE}/book-info` : '';

const TOKEN = new URLSearchParams(window.location.search).get('t') || '';

function plusMonths(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d.toISOString().slice(0, 10);
}
const today = () => new Date().toISOString().slice(0, 10);
const prettyDate = iso => {
  try { return new Date(`${iso}T00:00:00`).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  catch { return iso; }
};

const wrap = { minHeight: '100vh', background: '#f6f7fb', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', fontFamily: 'Arial, Helvetica, sans-serif', color: '#222' };
const card = { background: '#fff', borderRadius: '16px', boxShadow: '0 8px 40px rgba(0,0,0,0.10)', width: '100%', maxWidth: '460px', padding: '30px 26px' };
const btn = { width: '100%', padding: '14px', background: '#0f766e', color: '#fff', border: 'none', borderRadius: '10px', fontSize: '16px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: '50px' };
const btnDisabled = { ...btn, background: '#9ca3af', cursor: 'not-allowed' };
const input = { width: '100%', padding: '12px', fontSize: '15px', border: '1.5px solid #d6d9e0', borderRadius: '10px', fontFamily: 'inherit', boxSizing: 'border-box' };
const lbl = { fontSize: '12px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#888', marginBottom: '6px', display: 'block' };

function Shell({ children }) {
  return <div style={wrap}><div style={card}>{children}</div></div>;
}

export default function BookingPage() {
  const [phase, setPhase] = useState('loading'); // loading | form | done | error | already
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [bookedDates, setBookedDates] = useState([]);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('09:00');
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!TOKEN) { setPhase('error'); setMsg('This booking link is invalid. Please use the link in your invoice email.'); return; }
    if (!INFO_URL) { setPhase('error'); setMsg('Booking is not configured. Please contact us.'); return; }
    (async () => {
      try {
        const r = await fetch(`${INFO_URL}?t=${encodeURIComponent(TOKEN)}`);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'This booking link is invalid or expired.');
        if (data.alreadyBooked) { setPhase('already'); return; }
        setName(data.clientName || '');
        setBookedDates(data.bookedDates || []);
        // suggested date, nudged forward off any taken day
        let d = (data.suggest && /^\d{4}-\d{2}-\d{2}$/.test(data.suggest)) ? data.suggest : plusMonths(3);
        const taken = new Set(data.bookedDates || []);
        for (let i = 0; i < 14 && taken.has(d); i++) { const nd = new Date(`${d}T00:00:00`); nd.setDate(nd.getDate() + 1); d = nd.toISOString().slice(0, 10); }
        setDate(d);
        setPhase('form');
      } catch (e) { setPhase('error'); setMsg(e.message || 'This booking link is invalid or expired.'); }
    })();
  }, []);

  const dateTaken = bookedDates.includes(date);

  async function confirm() {
    if (dateTaken) { setErr('That day is already taken — please choose another.'); return; }
    setErr(''); setBusy(true);
    try {
      const r = await fetch(BOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ t: TOKEN, date, time }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Booking failed (${r.status})`);
      setPhase('done');
    } catch (e) { setErr(e.message || 'Booking failed — please try again.'); }
    finally { setBusy(false); }
  }

  if (phase === 'loading') return <Shell><p style={{ textAlign: 'center', color: '#666' }}>Loading your booking…</p></Shell>;

  if (phase === 'error') return (
    <Shell>
      <div style={{ fontSize: '20px', fontWeight: 800, color: '#2f3a8f', marginBottom: '10px' }}>Pearl View Window Cleaning</div>
      <p style={{ fontSize: '15px', color: '#444', lineHeight: 1.6 }}>{msg}</p>
    </Shell>
  );

  if (phase === 'already') return (
    <Shell>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '40px' }}>✅</div>
        <h2 style={{ color: '#2f3a8f', margin: '8px 0' }}>You're already booked</h2>
        <p style={{ fontSize: '15px', color: '#444', lineHeight: 1.6 }}>You've already got an upcoming clean with us. Need to change it? Just reply to your email and we'll sort it.</p>
      </div>
    </Shell>
  );

  if (phase === 'done') return (
    <Shell>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '44px', marginBottom: '8px' }}>🧼</div>
        <h2 style={{ color: '#2f3a8f', margin: '0 0 10px' }}>You're booked in!</h2>
        <p style={{ fontSize: '15px', lineHeight: 1.6, color: '#444' }}>Your next clean is set for<br /><strong>{prettyDate(date)} at {time}</strong>.</p>
        <p style={{ fontSize: '14px', color: '#666' }}>A calendar invite is on its way to your email so you can add it to your own calendar.</p>
        <p style={{ fontSize: '13px', color: '#999', marginTop: '18px' }}>Pearl View Window Cleaning</p>
      </div>
    </Shell>
  );

  // phase === 'form'
  return (
    <Shell>
      <div style={{ fontSize: '20px', fontWeight: 800, color: '#2f3a8f', marginBottom: '4px' }}>Pearl View Window Cleaning</div>
      <h2 style={{ margin: '8px 0 4px', fontSize: '22px' }}>Book your next clean</h2>
      <p style={{ fontSize: '15px', color: '#555', marginTop: 0 }}>{name ? `Hi ${name}, ` : ''}we suggest your next window clean for:</p>

      <div style={{ background: dateTaken ? '#fef2f2' : '#f0fdfa', border: `1.5px solid ${dateTaken ? '#fecaca' : '#99f6e4'}`, borderRadius: '12px', padding: '16px', textAlign: 'center', margin: '14px 0' }}>
        <div style={{ fontSize: '18px', fontWeight: 700, color: dateTaken ? '#b91c1c' : '#0f766e' }}>{prettyDate(date)}</div>
        <div style={{ fontSize: '14px', color: dateTaken ? '#b91c1c' : '#0f766e', marginTop: '2px' }}>{dateTaken ? 'That day is taken — pick another below' : `at ${time}`}</div>
      </div>

      {!manual ? (
        <>
          <button style={dateTaken ? btnDisabled : btn} onClick={confirm} disabled={busy || dateTaken}>
            {busy ? 'Booking…' : 'Confirm this date'}
          </button>
          <button onClick={() => setManual(true)} style={{ width: '100%', marginTop: '10px', background: 'none', border: 'none', color: '#0f766e', fontWeight: 700, fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit', padding: '8px' }}>
            Choose a different date/time
          </button>
        </>
      ) : (
        <>
          <div style={{ marginBottom: '12px' }}>
            <label style={lbl}>Date</label>
            <input style={input} type="date" value={date} min={today()} onChange={e => setDate(e.target.value)} />
            {dateTaken && <div style={{ color: '#dc2626', fontSize: '13px', marginTop: '6px' }}>Sorry, that day's already booked — please pick another.</div>}
          </div>
          <div style={{ marginBottom: '16px' }}>
            <label style={lbl}>Time</label>
            <input style={input} type="time" value={time} onChange={e => setTime(e.target.value)} />
          </div>
          <button style={dateTaken ? btnDisabled : btn} onClick={confirm} disabled={busy || dateTaken}>
            {busy ? 'Booking…' : 'Confirm booking'}
          </button>
        </>
      )}

      {err && <div style={{ color: '#dc2626', fontSize: '13px', marginTop: '12px', textAlign: 'center' }}>{err}</div>}
    </Shell>
  );
}
