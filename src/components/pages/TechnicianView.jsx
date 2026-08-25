import { useState, useMemo } from 'react';
import { useTechnicianBookings } from '../../hooks/useTechnicianBookings';
import { signOut } from '../../utils/supabaseClient';

const DOW    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = n => String(n).padStart(2, '0');
const TEAL = 'var(--primary, #0f766e)';

// Field-technician dashboard: their OWN assigned jobs only (RLS-scoped), organised
// into sections like the main dashboard — summary tiles, a month calendar, and a
// filterable job list with full job detail (address + maps, tap-to-call, quote,
// notes). Marking a job done flags it to the owner for invoicing (tech_completed_at).
export default function TechnicianView({ profile }) {
  const { myBookings, loading, markCompleted, reopen, saveTechNote } = useTechnicianBookings();
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const [year,  setYear]  = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [selDay, setSelDay] = useState(null);
  const [filter, setFilter] = useState('upcoming'); // upcoming | today | completed | all
  const [noteFor, setNoteFor] = useState(null);
  const [draft, setDraft] = useState('');

  const byDate = useMemo(() => myBookings.reduce((m, b) => {
    if (b.date) (m[b.date] ||= []).push(b);
    return m;
  }, {}), [myBookings]);

  const stats = useMemo(() => ({
    today:     myBookings.filter(b => b.date === todayISO && b.status !== 'Completed').length,
    upcoming:  myBookings.filter(b => b.date >= todayISO && b.status !== 'Completed').length,
    completed: myBookings.filter(b => b.status === 'Completed').length,
  }), [myBookings, todayISO]);

  const prefix = `${year}-${pad(month + 1)}-`;
  const jobDays = useMemo(() => {
    const s = new Set();
    Object.keys(byDate).forEach(d => { if (d.startsWith(prefix)) s.add(parseInt(d.slice(8, 10), 10)); });
    return s;
  }, [byDate, prefix]);

  const firstDow    = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const isToday = d => d === today.getDate() && month === today.getMonth() && year === today.getFullYear();

  // What the list shows: a tapped calendar day wins; otherwise the active filter.
  const selDate = selDay ? `${prefix}${pad(selDay)}` : null;
  const listJobs = useMemo(() => {
    if (selDate) return byDate[selDate] || [];
    const all = [...myBookings];
    if (filter === 'today')     return all.filter(b => b.date === todayISO);
    if (filter === 'completed') return all.filter(b => b.status === 'Completed').sort((a, b) => b.date.localeCompare(a.date));
    if (filter === 'all')       return all.sort((a, b) => a.date.localeCompare(b.date));
    return all.filter(b => b.date >= todayISO && b.status !== 'Completed'); // upcoming
  }, [selDate, byDate, myBookings, filter, todayISO]);

  function go(delta) {
    let m = month + delta, y = year;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    setMonth(m); setYear(y); setSelDay(null); setNoteFor(null);
  }
  function pickFilter(f) { setFilter(f); setSelDay(null); }

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const card = { background: '#fff', border: '1px solid var(--gray-100, #eee)', borderRadius: 14 };
  const btn  = { flex: 1, padding: 10, borderRadius: 8, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer', fontSize: 13 };
  const mapHref = a => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a)}`;

  function StatTile({ label, value, tone }) {
    return (
      <div style={{ ...card, flex: 1, padding: '12px 10px', textAlign: 'center' }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: tone }}>{value}</div>
        <div style={{ fontSize: 10.5, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.03em' }}>{label}</div>
      </div>
    );
  }

  function Chip({ id, label }) {
    const on = !selDate && filter === id;
    return (
      <button onClick={() => pickFilter(id)} style={{
        padding: '6px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer',
        border: `1px solid ${on ? TEAL : 'var(--gray-200, #e2e8f0)'}`, background: on ? TEAL : '#fff', color: on ? '#fff' : '#475569',
      }}>{label}</button>
    );
  }

  function JobCard({ b }) {
    const done = b.status === 'Completed';
    return (
      <div style={{ ...card, padding: 14, marginBottom: 10, background: done ? '#f0fdf4' : '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start' }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{b.name}</div>
          <span style={{ fontSize: 11, fontWeight: 700, color: done ? '#15803d' : TEAL, whiteSpace: 'nowrap' }}>
            {done ? '✓ Done' : (b.date === todayISO ? 'TODAY' : b.date?.slice(5))}
          </span>
        </div>
        <div style={{ color: '#475569', fontSize: 14, marginTop: 2 }}>{b.service}{b.time ? ` · ${b.time}` : ''}</div>

        {/* details grid */}
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {(b.address || b.city) && (
            <a href={mapHref(b.address || b.city)} target="_blank" rel="noreferrer"
               style={{ fontSize: 14, color: '#1d4ed8', textDecoration: 'none' }}>
              📍 {b.address || b.city} <span style={{ fontSize: 11, color: '#64748b' }}>· Open in Maps</span>
            </a>
          )}
          {b.phone && <a href={`tel:${b.phone}`} style={{ fontSize: 14, color: '#1d4ed8', textDecoration: 'none' }}>📞 {b.phone}</a>}
          {b.quote > 0 && <div style={{ fontSize: 14 }}>💵 Quote: <b>${b.quote.toLocaleString()}</b></div>}
          {b.notes && <div style={{ fontSize: 13, color: '#475569', whiteSpace: 'pre-wrap' }}>📝 {b.notes}</div>}
        </div>

        {done && (
          <div style={{ fontSize: 11.5, color: '#15803d', marginTop: 8, fontWeight: 600 }}>Sent to office for invoicing.</div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {done
            ? <button onClick={() => reopen(b.id)} style={{ ...btn, background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>Reopen</button>
            : <button onClick={() => markCompleted(b.id)} style={{ ...btn, background: TEAL, color: '#fff', border: 0 }}>Mark Done</button>}
          <button onClick={() => { setNoteFor(noteFor === b.id ? null : b.id); setDraft(b.notes); }}
                  style={{ ...btn, background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>
            {b.notes ? 'Edit Note' : 'Add Note'}
          </button>
        </div>

        {noteFor === b.id && (
          <div style={{ marginTop: 8 }}>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3}
              placeholder="Note for this job…" style={{ width: '100%', boxSizing: 'border-box', padding: 8, borderRadius: 8, border: '1px solid #ddd', fontFamily: 'inherit' }} />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button onClick={async () => { await saveTechNote(b.id, draft); setNoteFor(null); }} style={{ ...btn, background: TEAL, color: '#fff', border: 0 }}>Save</button>
              <button onClick={() => setNoteFor(null)} style={{ ...btn, background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ flex: 1, height: '100dvh', overflowY: 'auto', display: 'flex', justifyContent: 'center', background: 'var(--bg, #f7f7f5)' }}>
      <div style={{ width: '100%', maxWidth: 620, padding: 16, boxSizing: 'border-box', fontFamily: "'Montserrat', system-ui, sans-serif", color: 'var(--gray-800, #222)' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 20 }}>My Jobs</div>
            <div style={{ color: '#64748b', fontSize: 13 }}>{profile?.display_name || 'Technician'}</div>
          </div>
          <button onClick={signOut} style={{ padding: '8px 12px', background: '#fff', border: '1px solid #ddd', borderRadius: 8, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer' }}>Sign out</button>
        </header>

        {/* summary tiles */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <StatTile label="Today" value={stats.today} tone={TEAL} />
          <StatTile label="Upcoming" value={stats.upcoming} tone="#1d4ed8" />
          <StatTile label="Completed" value={stats.completed} tone="#15803d" />
        </div>

        {/* month calendar */}
        <div style={{ ...card, padding: 12, marginBottom: 14 }}>
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
                    aspectRatio: '1 / 1', border: isToday(d) ? `2px solid ${TEAL}` : '1px solid transparent',
                    borderRadius: 10, cursor: has ? 'pointer' : 'default', fontFamily: 'inherit',
                    fontSize: 13, fontWeight: has ? 700 : 500,
                    background: sel ? TEAL : has ? '#ccfbf1' : 'transparent',
                    color: sel ? '#fff' : has ? '#0f766e' : '#cbd5e1',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
                  }}>
                  {d}
                  {has && <span style={{ width: 5, height: 5, borderRadius: '50%', background: sel ? '#fff' : TEAL }} />}
                </button>
              );
            })}
          </div>
        </div>

        {/* filters */}
        {!selDate && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <Chip id="upcoming" label="Upcoming" />
            <Chip id="today" label="Today" />
            <Chip id="completed" label="Completed" />
            <Chip id="all" label="All" />
          </div>
        )}

        {/* section header */}
        <div style={{ fontSize: 12, fontWeight: 700, color: TEAL, textTransform: 'uppercase', letterSpacing: '.03em', margin: '2px 0 10px', display: 'flex', justifyContent: 'space-between' }}>
          <span>{selDate ? new Date(selDate).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : `${filter} jobs`}</span>
          {selDate && <button onClick={() => setSelDay(null)} style={{ background: 'none', border: 0, color: '#64748b', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>clear</button>}
        </div>

        {loading && <p style={{ color: '#64748b' }}>Loading…</p>}
        {!loading && listJobs.length === 0 && (
          <p style={{ color: '#64748b' }}>{selDate ? 'No job on this day.' : 'Nothing here.'}</p>
        )}
        {listJobs.map(b => <JobCard key={b.id} b={b} />)}
      </div>
    </div>
  );
}
