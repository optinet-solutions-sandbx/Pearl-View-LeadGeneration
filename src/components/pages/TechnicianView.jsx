import { useState } from 'react';
import { useTechnicianBookings } from '../../hooks/useTechnicianBookings';
import { signOut } from '../../utils/supabaseClient';

// Mobile-first screen for a field technician: their assigned jobs only (RLS-scoped),
// grouped by date. View details, tap-to-call, mark completed, add a note. No
// pricing, no leads, no revenue.
export default function TechnicianView({ profile }) {
  const { myBookings, loading, markCompleted, saveTechNote } = useTechnicianBookings();
  const [noteFor, setNoteFor] = useState(null);
  const [draft, setDraft] = useState('');

  const byDate = myBookings.reduce((m, b) => { (m[b.date] ||= []).push(b); return m; }, {});
  const dates = Object.keys(byDate).filter(Boolean).sort();

  const card = { border: '1px solid #eee', borderRadius: 12, padding: 14, marginBottom: 10 };
  const btn = { flex: 1, padding: 10, borderRadius: 8, fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' };

  return (
    <div style={{ maxWidth: 560, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif', color: '#222' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 20 }}>My Jobs</div>
          <div style={{ color: '#666', fontSize: 13 }}>{profile?.display_name || 'Technician'}</div>
        </div>
        <button onClick={signOut} style={{ ...btn, flex: 'none', background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>Sign out</button>
      </header>

      {loading && <p style={{ color: '#666' }}>Loading…</p>}
      {!loading && dates.length === 0 && <p style={{ color: '#666' }}>No jobs assigned to you yet.</p>}

      {dates.map(d => (
        <section key={d} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#0f766e', textTransform: 'uppercase', margin: '8px 0' }}>
            {new Date(d).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}
          </div>
          {byDate[d].map(b => (
            <div key={b.id} style={{ ...card, background: b.status === 'Completed' ? '#f0fdf4' : '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ fontWeight: 700 }}>{b.name}</div>
                {b.status === 'Completed' && <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d' }}>✓ Completed</span>}
              </div>
              <div style={{ color: '#555', fontSize: 14 }}>{b.service}{b.time ? ` · ${b.time}` : ''}</div>
              {b.location && <div style={{ fontSize: 14, marginTop: 4 }}>📍 {b.location}</div>}
              {b.phone && <div style={{ marginTop: 2 }}><a href={`tel:${b.phone}`} style={{ fontSize: 14, color: '#3b5bdb', textDecoration: 'none' }}>📞 {b.phone}</a></div>}
              {b.notes && <div style={{ fontSize: 13, color: '#666', marginTop: 6, whiteSpace: 'pre-wrap' }}>📝 {b.notes}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {b.status !== 'Completed' && (
                  <button onClick={() => markCompleted(b.id)} style={{ ...btn, background: '#0f766e', color: '#fff', border: 0 }}>Mark Completed</button>
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
                    <button onClick={async () => { await saveTechNote(b.id, draft); setNoteFor(null); }} style={{ ...btn, background: '#0f766e', color: '#fff', border: 0 }}>Save</button>
                    <button onClick={() => setNoteFor(null)} style={{ ...btn, background: '#fff', border: '1px solid #ddd', fontWeight: 600 }}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
