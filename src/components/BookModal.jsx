import { useState } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import { overlayClose } from '../utils/overlayClose';

// Native time input — converts between "9:00 AM" display format and HH:MM input value
function TimePicker({ value, onChange }) {
  function toInput(str) {
    if (!str) return '';
    const m = str.match(/(\d+):(\d+)\s*(AM|PM)?/i);
    if (!m) return '';
    let h = parseInt(m[1]);
    const min = m[2].padStart(2, '0');
    const p = (m[3] || 'AM').toUpperCase();
    if (p === 'PM' && h < 12) h += 12;
    if (p === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}`;
  }
  function fromInput(str) {
    if (!str) return '';
    const [hStr, mStr] = str.split(':');
    let h = parseInt(hStr);
    const period = h >= 12 ? 'PM' : 'AM';
    if (h > 12) h -= 12;
    if (h === 0) h = 12;
    return `${h}:${mStr} ${period}`;
  }
  return (
    <input
      type="time"
      value={toInput(value)}
      onChange={e => onChange(e.target.value ? fromInput(e.target.value) : '')}
      className="finput"
      style={{ width: '100%', boxSizing: 'border-box' }}
    />
  );
}

export default function BookModal() {
  const { bookModalId, confirmBook, closeBookModal, leads } = useLeadsContext();

  const [date,   setDate]   = useState(new Date().toISOString().slice(0, 10));
  const [time,   setTime]   = useState('');
  const [worker, setWorker] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Cash');
  const [err,    setErr]    = useState('');

  if (!bookModalId) return null;
  const lead = leads.find(l => l.id === bookModalId);

  function handleSubmit() {
    if (!date) { setErr('Please select a date'); return; }
    setErr('');
    confirmBook({ date, jobTime: time, worker, amount: parseFloat(amount) || 0, paymentMethod: method });
  }

  const lbl = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '6px', display: 'block' };
  const hasAmount = parseFloat(amount) > 0;

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 3000, overflowY: 'auto' }}
      {...overlayClose(closeBookModal)}
    >
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', boxShadow: '0 -8px 40px rgba(0,0,0,0.22)', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--gray-100)' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>📅 Book Job</div>
            <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>{lead?.name}</div>
          </div>
          <button onClick={closeBookModal} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--gray-400)', padding: '4px' }}>✕</button>
        </div>

        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label style={lbl}>Date *</label>
            <input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="finput"
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          <div>
            <label style={lbl}>Job Time (optional)</label>
            <TimePicker value={time} onChange={setTime} />
          </div>

          <div>
            <label style={lbl}>Assigned Worker (optional)</label>
            <input
              type="text"
              value={worker}
              onChange={e => setWorker(e.target.value)}
              placeholder="e.g. John"
              className="finput"
              style={{ width: '100%', boxSizing: 'border-box' }}
            />
          </div>

          {/* Amount — if entered, recorded as Revenue immediately */}
          <div>
            <label style={lbl}>Payment Amount (optional)</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-500)', fontWeight: 700 }}>$</span>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="finput"
                style={{ width: '100%', boxSizing: 'border-box', paddingLeft: '24px' }}
              />
            </div>
            {hasAmount && (
              <div style={{ marginTop: '8px' }}>
                <label style={{ ...lbl, marginBottom: '6px' }}>Payment Method</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {['Cash', 'Bank'].map(mt => (
                    <button key={mt} type="button" onClick={() => setMethod(mt)} style={{
                      flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                      cursor: 'pointer', fontFamily: 'inherit',
                      border: `1.5px solid ${method === mt ? (mt === 'Cash' ? '#16a34a' : '#2563eb') : 'var(--gray-200)'}`,
                      background: method === mt ? (mt === 'Cash' ? '#f0fdf4' : '#eff6ff') : '#fff',
                      color: method === mt ? (mt === 'Cash' ? '#16a34a' : '#2563eb') : 'var(--gray-500)',
                    }}>
                      {mt.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: '6px', fontSize: '11px', color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '5px 8px' }}>
                  Payment will be recorded as Revenue
                </div>
              </div>
            )}
          </div>

          {err && (
            <div style={{ fontSize: '12px', color: '#dc2626', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>{err}</div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <button
              onClick={closeBookModal}
              style={{ padding: '11px', background: '#f9fafb', color: 'var(--gray-700)', border: '1px solid var(--gray-200)', borderRadius: '8px', fontSize: '14px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              style={{ padding: '11px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Confirm Booking
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
