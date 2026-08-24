import { useState, useMemo } from 'react';
import { useTechnicianBookings } from '../../hooks/useTechnicianBookings';
import { signOut } from '../../utils/supabaseClient';

const DOW    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');

// Mobile-first calendar for a field technician: a month grid of ONLY their own
// assigned jobs (RLS-scoped), tap a day to see that job + mark it done / add a
// note. No pricing, no leads, no revenue.
export default function TechnicianView({ profile }) {
  const { myBookings, loading, markCompleted, saveTechNote } = useTechnicianBookings();
  const today = new Date();
  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selDay, setSelDay] = useState(null);
  const [noteFor, setNoteFor] = useState(null);
  const [draft, setDraft] = useState('');

  // group jobs by YYYY-MM-DD
  const byDate = useMemo(() => myBookings.reduce((m, b) => {
    if (b.date) (m[b.date] ||= []).push(b);
    return m;
  }, {}), [myBookings]);

  const prefix = `${year}-${pad(month + 1)}-`;
  const jobDays = useMemo(() => {
    const s = new Set();
    Object.keys(byDate).forEach(d => { if (d.startsWith(prefix)) s.add(parseInt(d.slice(8, 10), 10)); });
    return s;
  }, [byDate, prefix]);

  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isToday = d => d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  const todayISO = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const selDate = selDay ? `${prefix}${pad(selDay)}` : null;
  const detailJobs = selDate ? (byDate[selDate] || [])
    : Object.keys(byDate).filter(d => d >= todayISO).sort().flatMap(d => byDate[d]); // fallback: upcoming

  function go(delta) {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    setMonth(m); setYear(y); setSelDay(null); setNoteFor(null);
  }

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const btn = { flex: 1, padding: 10, borderRadius: 8, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', fontSize: 13 };
  const teal = '#0f766e';

  function JobCard({ b }) {
    return (
      <div style={{ border: '1px solid #eee', borderRadius: 12, padding: 14, marginBottom: 10, background: b.status === 'Completed' ? '#f0fdf4' : '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontWeight: 700 }}>{b.name}</div>
          {b.status === 'Completed'
            ? <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d' }}>✓ Completed</span>
            : <span style={{ fontSize: 11, color: '#64748b' }}>{b.date?.slice(5)}</span>}
        </div>
        <div style={{ color: '#555', fontSize: 14 }}>{b.service}{b.time ? ` · ${b.time}` : ''}</div>
        {b.location && <div style={{ fontSize: 14, marginTop: 4 }}>📍 {b.location}</div>}
        {b.phone && <div style={{ marginTop: 2 }}><a href={`tel:${b.phone}`} style={{ fontSize: 14, color: '#3b5bdb', textDecoration: 'none' }}>📞 {b.phone}</a></div>}
        {b.notes && <div style={{ fontSize: 13, color: '#666', marginTop: 6, whiteSpace: 'pre-wrap' }}>📝 {b.notes}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {b.status !== 'Completed' && (
            <button onClick={() => markCompleted(b.id)} style={{ ...btn, background: teal, color: '#fff', border: 0 }}>Mark Completed</button>
          )}
          <button onClick={() => { setNoteFor(b.id); setDraft(b.notes); }} style={{ ...btn, background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>
            {b.notes ? 'Edit Note' : 'Add Note'}
          </button>
        </div>
        {noteFor === b.id && (
          <div style={{ marginTop: 8 }}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3}
              placeholder="Note for this job…" style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={async () => { await saveTechNote(b.id, draft); setNoteFor(null); }} style={{ ...btn, background: teal, color: '#fff', border: 0 }}>Save</button>
              <button onClick={() => setNoteFor(null)} style={{ ...btn, background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, height: '100dvh', overflowY: 'auto', display: 'flex', justifyContent: 'center', background: 'var(--bg, #f7f7f5)' }}>
      <div style={{ width: '100%', maxWidth: 560, padding: 16, boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif', color: '#222' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 20 }}>My Jobs</div>
            <div style={{ color: '#666', fontSize: 13 }}>{profile?.display_name || 'Technician'}</div>
          </div>
          <button onClick={signOut} style={{ padding: '8px 12px', background: '#fff', border: '1px solid #ddd', borderRadius: 8, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>Sign out</button>
        </header>

        {loading && <p style={{ color: '#666' }}>Loading…</p>}

        {/* Month calendar */}
        <div style={{ background: '#fff', border: '1px solid #eee', borderRadius: 14, padding: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <button onClick={() => go(-1)} aria-label="Previous month" style={{ background: '#f1f5f9', border: 0, borderRadius: 8, width: 34, height: 34, fontSize: 16, cursor: 'pointer' }}>‹</button>
            <div style={{ fontWeight: 700 }}>{MONTHS[month]} {year}</div>
            <button onClick={() => go(1)} aria-label="Next month" style={{ background: '#f1f5f9', border: 0, borderRadius: 8, width: 34, height: 34, fontSize: 16, cursor: 'pointer' }}>›</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {DOW.map(d => <div key={d} style={{ textAlign: 'center', fontSize: 10.5, fontWeight: 700, color: '#94a3b8', padding: '2px 0' }}>{d}</div>)}
            {cells.map((d, i) => {
              if (d === null) return <div key={`e${i}`} />;
              const has = jobDays.has(d);
              const sel = d === selDay;
              return (
                <button key={d} disabled={!has} onClick={() => setSelDay(sel ? null : d)}
                  style={{
                    aspectRatio: '1 / 1', border: isToday(d) ? `2px solid ${teal}` : '1px solid transparent',
                    borderRadius: 10, cursor: has ? 'pointer' : 'default', fontFamily: 'inherit',
                    fontSize: 13, fontWeight: has ? 700 : 500,
                    background: sel ? teal : has ? '#ccfbf1' : 'transparent',
                    color: sel ? '#fff' : has ? '#0f766e' : '#cbd5e1',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2, position: 'relative',
                  }}>
                  {d}
                  {has && <span style={{ width: 5, height: 5, borderRadius: '50%', background: sel ? '#fff' : teal }} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail: selected day, or upcoming when nothing selected */}
        <div style={{ fontSize: 12, fontWeight: 700, color: teal, textTransform: 'uppercase', margin: '4px 0 10px' }}>
          {selDate
            ? new Date(selDate).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
            : 'Upcoming jobs'}
        </div>
        {!loading && detailJobs.length === 0 && (
          <p style={{ color: '#666' }}>{selDate ? 'No job on this day.' : 'No jobs assigned to you yet.'}</p>
        )}
        {detailJobs.map(b => <JobCard key={b.id} b={b} />)}
      </div>
    </div>
  );
}
