import { useState, useMemo } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import { createRecord, AT_TABLES } from '../../utils/airtableSync';

const DAYS     = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const SERVICES = ['Window Cleaning', 'Pressure Washing', 'Solar Panel', 'Other'];
const ROWS_PER_PAGE = 50;

function mkDate(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Complete Job modal (payment + upsell) ─────────────────────────────────────
function CompleteJobModal({ booking, onClose, onConfirm }) {
  const [method,      setMethod]      = useState('Cash');
  const [amount,      setAmount]      = useState(booking.amount > 0 ? String(booking.amount) : '');
  const [upsellAmt,   setUpsellAmt]   = useState('');
  const [upsellNotes, setUpsellNotes] = useState('');
  const [err,         setErr]         = useState('');

  // Done + payment: requires an amount
  function handleSubmitPaid() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setErr('Enter the payment amount, or use "Collect payment later"'); return; }
    setErr('');
    onConfirm({
      amount: amt,
      method,
      upsellAmount: parseFloat(upsellAmt) || 0,
      upsellNotes:  upsellNotes.trim(),
    });
    onClose();
  }

  // Done WITHOUT payment: marks the job done, no Revenue, lead not marked paid
  function handleSubmitUnpaid() {
    setErr('');
    onConfirm({ amount: 0, method, upsellAmount: 0, upsellNotes: '', noPayment: true });
    onClose();
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 2200, padding: '0', overflowY: 'auto' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', boxShadow: '0 -8px 40px rgba(0,0,0,0.22)', overflow: 'hidden', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: '1px solid var(--gray-100)' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--gray-900)' }}>✅ Mark Job as Done</div>
            <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>{booking.clientName}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--gray-400)', padding: '4px' }}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* Payment */}
          <div>
            <label style={fLbl}>Payment Method</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              {['Cash', 'Bank'].map(m => (
                <button key={m} onClick={() => setMethod(m)} style={{
                  flex: 1, padding: '9px', borderRadius: '8px', fontSize: '13px', fontWeight: 700,
                  cursor: 'pointer', fontFamily: 'inherit',
                  border: `1.5px solid ${method === m ? (m === 'Cash' ? '#16a34a' : '#2563eb') : 'var(--gray-200)'}`,
                  background: method === m ? (m === 'Cash' ? '#f0fdf4' : '#eff6ff') : '#fff',
                  color: method === m ? (m === 'Cash' ? '#16a34a' : '#2563eb') : 'var(--gray-500)',
                }}>
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={fLbl}>Amount Paid</label>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-500)', fontWeight: 700, fontSize: '14px' }}>$</span>
              <input
                type="number" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder="0.00" autoFocus
                style={{ width: '100%', padding: '9px 12px 9px 26px', fontSize: '16px', fontWeight: 700, border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>

          {/* Upsell (optional) */}
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px', padding: '12px 14px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: '#92400e', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '.04em' }}>Upsell (optional)</div>
            <div>
              <label style={fLbl}>Extra Amount ($)</label>
              <div style={{ position: 'relative', marginBottom: '8px' }}>
                <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-500)', fontWeight: 700, fontSize: '14px' }}>$</span>
                <input
                  type="number" value={upsellAmt} onChange={e => setUpsellAmt(e.target.value)}
                  placeholder="0.00"
                  style={{ width: '100%', padding: '8px 12px 8px 26px', fontSize: '14px', fontWeight: 600, border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <div>
              <label style={fLbl}>Description</label>
              <input
                type="text" value={upsellNotes} onChange={e => setUpsellNotes(e.target.value)}
                placeholder="e.g. Extra floor, gutter clean…"
                style={{ width: '100%', padding: '8px 11px', fontSize: '13px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
              />
            </div>
          </div>

          {err && <div style={{ fontSize: '12px', color: '#dc2626', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>{err}</div>}
          <button onClick={handleSubmitPaid} style={{ width: '100%', padding: '11px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: '44px' }}>
            Job Done + Record Payment
          </button>
          <button onClick={handleSubmitUnpaid} style={{ width: '100%', padding: '11px', background: '#fff', color: '#16a34a', border: '1.5px solid #16a34a', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', minHeight: '44px' }}>
            Job Done — Collect Payment Later
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Time picker — native browser time input, converts to/from "9:00 AM" ──────
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
      style={{ ...fInput, marginBottom: '10px' }}
    />
  );
}

// ── Shared appointment form fields ───────────────────────────────────────────
function AppointmentFormFields({ form, setField, leads = [], clients = [] }) {
  const [showSuggestions, setShowSuggestions] = useState(false);

  const suggestions = useMemo(() => {
    if (form.clientName.trim().length < 1) return [];
    const term = form.clientName.toLowerCase();
    const seen = new Set();
    const result = [];
    clients.forEach(c => {
      if (!c.name?.toLowerCase().includes(term)) return;
      const key = (c.phone || c.name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ id: c.id, name: c.name, phone: c.phone, city: c.city, address: c.address, fromClients: true });
    });
    leads.forEach(l => {
      if (!l.name?.toLowerCase().includes(term)) return;
      const key = (l.phone || l.name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ id: l.id, name: l.name, phone: l.phone, city: l.city, address: l.address, fromClients: false });
    });
    return result.slice(0, 8);
  }, [form.clientName, clients, leads]);

  function selectSuggestion(item) {
    setField('clientName', item.name);
    setField('phone', item.phone || '');
    if (item.city)    setField('city',    item.city);
    if (item.address) setField('address', item.address);
    setShowSuggestions(false);
  }

  return (
    <>
      <label style={fLbl}>Service</label>
      <select value={form.service} onChange={e => setField('service', e.target.value)} style={{ ...fInput, appearance: 'none' }}>
        {SERVICES.map(s => <option key={s}>{s}</option>)}
      </select>
      <label style={fLbl}>Client Name <span style={{ color: '#dc2626' }}>*</span></label>
      <div style={{ position: 'relative', marginBottom: '10px' }}>
        <input
          value={form.clientName}
          onChange={e => { setField('clientName', e.target.value); setShowSuggestions(true); }}
          onFocus={() => setShowSuggestions(true)}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
          placeholder="Full name…"
          style={{ ...fInput, marginBottom: 0 }}
          autoComplete="off"
        />
        {showSuggestions && suggestions.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', marginTop: '2px', overflow: 'hidden' }}>
            {suggestions.map(item => (
              <div key={item.id} onMouseDown={() => selectSuggestion(item)}
                style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'center', gap: '8px' }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--gray-50)'}
                onMouseLeave={e => e.currentTarget.style.background = ''}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>{item.name}</span>
                  <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '1px' }}>
                    {[item.phone, item.city, item.address].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {item.fromClients && <span style={{ fontSize: '9px', fontWeight: 700, background: '#eff6ff', color: 'var(--primary)', padding: '1px 5px', borderRadius: '6px', flexShrink: 0 }}>CLIENT</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <label style={fLbl}>Phone</label>
      <input value={form.phone} onChange={e => setField('phone', e.target.value)} placeholder="e.g. 0400 000 000" style={fInput} />
      <label style={fLbl}>City / Location</label>
      <input value={form.city} onChange={e => setField('city', e.target.value)} placeholder="e.g. Brisbane" style={fInput} />
      <label style={fLbl}>Address</label>
      <input value={form.address || ''} onChange={e => setField('address', e.target.value)} placeholder="e.g. 123 Main St" style={fInput} />
      <label style={fLbl}>Job Time</label>
      <TimePicker value={form.jobTime || ''} onChange={v => setField('jobTime', v)} />
      <label style={fLbl}>Assigned Worker</label>
      <input value={form.assignedWorker || ''} onChange={e => setField('assignedWorker', e.target.value)} placeholder="e.g. John" style={{ ...fInput, marginBottom: 0 }} />
    </>
  );
}

// ── Edit booking modal ────────────────────────────────────────────────────────
function EditBookingModal({ booking, onSave, onClose, onCancel, onComplete, leads = [], clients = [] }) {
  const [form, setForm] = useState({
    clientName:     booking.clientName     || '',
    phone:          booking.phone          || '',
    city:           booking.city           || '',
    address:        booking.address        || '',
    service:        booking.service        || 'Window Cleaning',
    jobTime:        booking.jobTime        || '',
    assignedWorker: booking.assignedWorker || '',
  });
  const [err,          setErr]          = useState('');
  const [showComplete, setShowComplete] = useState(false);

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })); }
  function handleSave() {
    if (!form.clientName.trim()) { setErr('Client name is required'); return; }
    setErr('');
    onSave(form);
  }

  const isDone = booking.bookingStatus === 'Completed';

  return (
    <div style={modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', maxHeight: '92dvh', display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 40px rgba(0,0,0,0.18)', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--gray-100)', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>Edit Appointment</div>
            <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>{booking.date}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--gray-400)', padding: '4px' }}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', overflowY: 'auto', flex: 1 }}>

          {/* Completed status banner */}
          {isDone && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '10px', padding: '10px 14px', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', fontWeight: 700, color: '#15803d' }}>✓ Job Completed</span>
              {booking.amount > 0 && <span style={{ fontSize: '12px', color: '#16a34a' }}>· ${booking.amount.toLocaleString()}</span>}
              {booking.upsellAmount > 0 && <span style={{ fontSize: '11px', color: '#d97706', background: '#fffbeb', border: '1px solid #fde68a', padding: '1px 6px', borderRadius: '6px' }}>+${booking.upsellAmount} upsell</span>}
            </div>
          )}

          <AppointmentFormFields form={form} setField={setField} leads={leads} clients={clients} />

          {err && <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '10px', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>{err}</div>}

          <button onClick={handleSave} style={{ width: '100%', padding: '10px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: '14px' }}>
            Save Changes
          </button>

          {/* Mark Done button */}
          {!isDone && (
            <button
              onClick={() => setShowComplete(true)}
              style={{ width: '100%', padding: '10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '14px', height: '14px' }}><polyline points="20 6 9 17 4 12"/></svg>
              Mark Job as Done
            </button>
          )}

          {onCancel && (
            <button onClick={onCancel} style={{ width: '100%', padding: '10px', background: '#fff', color: '#dc2626', border: '1.5px solid #fecaca', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: '8px' }}>
              Cancel Booking
            </button>
          )}
        </div>
      </div>

      {showComplete && (
        <CompleteJobModal
          booking={booking}
          onClose={() => setShowComplete(false)}
          onConfirm={data => { onComplete(data); onClose(); }}
        />
      )}
    </div>
  );
}

// ── Booking modal (click a day on the calendar) ───────────────────────────────
function BookingModal({ year, month, day, leads, clients = [], addCalBooking, onClose }) {
  const [form,    setForm]    = useState({ clientName: '', phone: '', city: '', address: '', service: 'Window Cleaning', jobTime: '', assignedWorker: '', amount: '', method: 'Cash' });
  const [formErr, setFormErr] = useState('');

  const targetDate  = mkDate(year, month, day);
  const displayDate = `${MONTHS[month]} ${day}, ${year}`;

  function setField(k, v) { setForm(f => ({ ...f, [k]: v })); }

  function handleSubmitNew() {
    if (!form.clientName.trim()) { setFormErr('Client name is required'); return; }
    setFormErr('');
    const amt = parseFloat(form.amount) || 0;
    addCalBooking({ ...form, date: targetDate, amount: amt });
    // If amount entered, write Revenue record immediately
    if (amt > 0) {
      createRecord(AT_TABLES.revenue, {
        'Revenue Name':   `${form.clientName} - ${form.service || 'Window Cleaning'}`,
        'Date':           targetDate,
        'Client Name':    form.clientName,
        'Phone':          form.phone || '',
        'Job_Service':    form.service || 'Window Cleaning',
        'City':           form.city || '',
        'Payment_Method': form.method || 'Cash',
        'Amount':         amt,
        'Status':         'Job Done',
      });
    }
    onClose();
  }

  return (
    <div style={modalOverlay} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', maxHeight: '92dvh', display: 'flex', flexDirection: 'column', boxShadow: '0 -8px 40px rgba(0,0,0,0.18)', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--gray-100)', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>New Appointment</div>
            <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>{displayDate}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--gray-400)', padding: '4px' }}>✕</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>
          <AppointmentFormFields form={form} setField={setField} leads={leads} clients={clients} />

          {/* Amount — records as Revenue immediately if filled */}
          <label style={fLbl}>Payment Amount (optional)</label>
          <div style={{ position: 'relative', marginBottom: '10px' }}>
            <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-500)', fontWeight: 700, fontSize: '14px' }}>$</span>
            <input type="number" value={form.amount} onChange={e => setField('amount', e.target.value)} placeholder="0.00"
              style={{ ...fInput, paddingLeft: '24px', marginBottom: 0 }} />
          </div>
          {parseFloat(form.amount) > 0 && (
            <div style={{ marginBottom: '10px' }}>
              <label style={fLbl}>Payment Method</label>
              <div style={{ display: 'flex', gap: '8px' }}>
                {['Cash', 'Bank'].map((mt, i) => (
                  <button key={mt} type="button" onClick={() => setField('method', mt)} style={{
                    flex: 1, padding: '8px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                    cursor: 'pointer', fontFamily: 'inherit',
                    border: `1.5px solid ${form.method === mt ? (mt === 'Cash' ? '#16a34a' : '#2563eb') : 'var(--gray-200)'}`,
                    background: form.method === mt ? (mt === 'Cash' ? '#f0fdf4' : '#eff6ff') : '#fff',
                    color: form.method === mt ? (mt === 'Cash' ? '#16a34a' : '#2563eb') : 'var(--gray-500)',
                  }}>
                    {mt.toUpperCase()}
                  </button>
                ))}
              </div>
              <div style={{ marginTop: '6px', fontSize: '11px', color: '#16a34a', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: '6px', padding: '5px 8px' }}>
                Will be recorded as Revenue
              </div>
            </div>
          )}

          {formErr && <div style={{ fontSize: '12px', color: '#dc2626', marginTop: '4px', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>{formErr}</div>}
          <button
            onClick={handleSubmitNew}
            style={{ width: '100%', padding: '10px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: '10px' }}
          >
            Add Appointment
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main CalendarPage ─────────────────────────────────────────────────────────
export default function CalendarPage() {
  const {
    leads, calBookings, clients,
    saveJobDate, openPanel, setCurrentPage, changeStatus,
    addCalBooking, removeCalBooking, updateCalBooking, recordBookingPayment,
    showToast,
  } = useLeadsContext();

  const today = new Date();
  const [year,        setYear]        = useState(today.getFullYear());
  const [month,       setMonth]       = useState(today.getMonth());
  const [selectedDay, setSelectedDay] = useState(null);
  const [modalDay,    setModalDay]    = useState(null);
  const [editBooking,    setEditBooking]    = useState(null);
  const [tableSearch,    setTableSearch]    = useState('');
  const [tablePage,      setTablePage]      = useState(0);
  const [hideCompleted,  setHideCompleted]  = useState(true);

  const monthCalBookings = calBookings
    .filter(b => { const d = new Date(b.date); return d.getFullYear() === year && d.getMonth() === month; })
    .filter(b => b.bookingStatus !== 'Cancelled')
    .map(b => ({ ...b, parsedDate: new Date(b.date), name: b.clientName, isCalBooking: true, jobType: b.service }));

  // Exclude leads that already have a calBooking this month — prevents duplicates
  // (confirmBook / booking sync create both a calBooking AND a lead). Match by
  // phone (digits) OR Client Name, since calendar jobs often have no phone.
  const dig = s => (s || '').replace(/\D/g, '');
  const nmz = s => (s || '').trim().toLowerCase();
  const calBookingPhones = new Set(monthCalBookings.map(b => dig(b.phone)).filter(Boolean));
  const calBookingNames  = new Set(monthCalBookings.map(b => nmz(b.name)).filter(Boolean));
  const monthLeadBookings = leads
    .filter(l => l.jobDate && l.status !== 'refused' && l.status !== 'scam' && l.status !== 'archived' && l.status !== 'job_done'
      && !(dig(l.phone) && calBookingPhones.has(dig(l.phone)))
      && !(nmz(l.name) && calBookingNames.has(nmz(l.name))))
    .map(l => ({ ...l, parsedDate: new Date(l.jobDate), isCalBooking: false }))
    .filter(b => b.parsedDate.getFullYear() === year && b.parsedDate.getMonth() === month);

  const allMonthBookings = [...monthLeadBookings, ...monthCalBookings];

  const byDay = {};
  allMonthBookings.forEach(b => {
    const d = b.parsedDate.getDate();
    if (!byDay[d]) byDay[d] = [];
    byDay[d].push(b);
  });

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth    = new Date(year, month + 1, 0).getDate();
  const bookedDayCount     = Object.keys(byDay).length;
  const availableDayCount  = daysInMonth - bookedDayCount;
  const totalBookingsCount = allMonthBookings.length;

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear(y => y - 1); } else setMonth(m => m - 1);
    setSelectedDay(null);
  }
  function nextMonth() {
    if (month === 11) { setMonth(0); setYear(y => y + 1); } else setMonth(m => m + 1);
    setSelectedDay(null);
  }
  function isToday(d) { return d === today.getDate() && month === today.getMonth() && year === today.getFullYear(); }
  function goToLead(id) { setCurrentPage('leads'); setTimeout(() => openPanel(id), 100); }

  function handleComplete(booking, { amount, method, upsellAmount, upsellNotes, noPayment }) {
    // Mark booking Completed. When no payment is taken, keep the existing amount
    // (don't overwrite it with 0).
    updateCalBooking(booking.id, {
      bookingStatus: 'Completed',
      ...(noPayment ? {} : { amount }),
      upsellAmount: upsellAmount || 0,
      upsellNotes:  upsellNotes || '',
    });
    // Mark done; recordBookingPayment writes Revenue + paid ONLY when amount > 0
    recordBookingPayment(booking.id, noPayment ? 0 : amount, method);
    // If there's an upsell, write a separate Revenue record for it
    if (!noPayment && upsellAmount > 0) {
      createRecord(AT_TABLES.revenue, {
        'Revenue Name':   `${booking.clientName} - Upsell: ${upsellNotes || 'Extra Service'}`,
        'Date':           new Date().toISOString().split('T')[0],
        'Client Name':    booking.clientName,
        'Phone':          booking.phone || '',
        'Job_Service':    'Upsell',
        'City':           booking.city || '',
        'Payment_Method': method || 'Cash',
        'Amount':         upsellAmount,
        'Status':         'Job Done',
      });
    }
    // Move the linked lead to Job Done status
    const linkedLead = leads.find(l =>
      (booking.linkedLeadId && l.id === booking.linkedLeadId) ||
      (booking.phone && l.phone === booking.phone)
    );
    if (linkedLead && linkedLead.status !== 'job_done') {
      changeStatus(linkedLead.id, 'job_done');
    }
    showToast('Job marked as done ✓ — Revenue recorded');
    setEditBooking(null);
  }

  const selectedHasBookings = selectedDay && (byDay[selectedDay] || []).length > 0;
  const tableRows = selectedHasBookings
    ? byDay[selectedDay]
    : allMonthBookings.sort((a, b) => a.parsedDate - b.parsedDate);
  const tableTitle = selectedHasBookings
    ? `${MONTHS[month]} ${selectedDay}, ${year}`
    : `All Bookings — ${MONTHS[month]} ${year}`;

  const completedCount = tableRows.filter(b => b.bookingStatus === 'Completed').length;
  const searchedRows = tableRows
    .filter(b => !hideCompleted || b.bookingStatus !== 'Completed')
    .filter(b => {
      if (!tableSearch) return true;
      const q = tableSearch.toLowerCase();
      return (b.name || '').toLowerCase().includes(q) || (b.phone || '').includes(q);
    });
  const totalPages = Math.max(1, Math.ceil(searchedRows.length / ROWS_PER_PAGE));
  const safePage   = Math.min(tablePage, totalPages - 1);
  const pagedRows  = searchedRows.slice(safePage * ROWS_PER_PAGE, (safePage + 1) * ROWS_PER_PAGE);

  return (
    <div className="page">
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Calendar</div>
        <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>Advance bookings and scheduled jobs</div>
      </div>

      {/* ── Calendar card ── */}
      <div style={{ background: '#fff', borderRadius: '14px', border: '1px solid var(--gray-200)', marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--gray-100)' }}>
          <button onClick={prevMonth} className="cal-nav-btn">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '13px', height: '13px' }}><path d="M15 18l-6-6 6-6"/></svg>
          </button>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>{MONTHS[month]} {year}</div>
          <button onClick={nextMonth} className="cal-nav-btn">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '13px', height: '13px' }}><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
        <div className="cal-grid-hdr">
          {DAYS.map(d => <div key={d} className="cal-day-hdr">{d}</div>)}
        </div>
        <div className="cal-grid-cells">
          {Array.from({ length: firstDayOfWeek }).map((_, i) => <div key={`blank-${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const bookingsOnDay = byDay[day] || [];
            const hasBooked    = bookingsOnDay.length > 0;
            const activeCount  = bookingsOnDay.filter(b => b.bookingStatus !== 'Completed').length;
            const count        = activeCount || bookingsOnDay.length;
            const isSelected = selectedDay === day;
            const todayMark  = isToday(day);

            let circleBg = 'transparent', circleColor = 'var(--gray-700)', circleBorder = 'none', fontWeight = 400;
            if (isSelected) { circleBg = 'var(--primary)'; circleColor = '#fff'; fontWeight = 700; }
            else if (hasBooked && count >= 2) { circleBg = '#7f1d1d'; circleColor = '#fff'; fontWeight = 700; }
            else if (hasBooked) { circleBg = '#4d7c0f'; circleColor = '#fff'; fontWeight = 700; }
            if (todayMark && !isSelected) {
              circleBorder = '2.5px solid var(--primary)';
              if (!hasBooked) { circleColor = 'var(--primary)'; fontWeight = 700; }
            }
            return (
              <div key={day} onClick={() => { if (hasBooked) setSelectedDay(isSelected ? null : day); else setModalDay(day); }} className="cal-day-cell">
                <div className="cal-circle" style={{ background: circleBg, border: circleBorder }} title={`${MONTHS[month]} ${day}`}>
                  <span style={{ fontWeight, color: circleColor, lineHeight: 1 }}>{day}</span>
                  {hasBooked && !isSelected && <span className="cal-count-badge">{count}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="cal-legend-wrap">
          <div className="cal-legend-item">
            <span className="cal-legend-circle" style={{ border: '1.5px solid var(--gray-300)', color: 'var(--gray-600)', background: '#fff' }}>{availableDayCount}</span>
            <span>Available</span>
          </div>
          <div className="cal-legend-item">
            <span className="cal-legend-circle" style={{ background: '#4d7c0f', color: '#fff' }}>{bookedDayCount}</span>
            <span>Booked days</span>
          </div>
          <div className="cal-legend-item">
            <span className="cal-legend-circle" style={{ border: '2.5px solid var(--primary)', color: 'var(--primary)', background: '#fff' }}>{totalBookingsCount}</span>
            <span>Total bookings</span>
          </div>
        </div>
      </div>

      {/* ── Bookings table ── */}
      <div style={{ background: '#fff', borderRadius: '14px', border: '1px solid var(--gray-200)' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--gray-100)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--gray-900)' }}>{tableTitle}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11px', fontWeight: 700, background: '#eff6ff', color: 'var(--primary)', borderRadius: '20px', padding: '2px 10px' }}>
                {searchedRows.length} job{searchedRows.length !== 1 ? 's' : ''}
              </span>
              {completedCount > 0 && (
                <button
                  onClick={() => setHideCompleted(v => !v)}
                  style={{ fontSize: '10.5px', fontWeight: 600, color: hideCompleted ? 'var(--gray-500)' : '#15803d', background: hideCompleted ? '#f9fafb' : '#f0fdf4', border: `1px solid ${hideCompleted ? 'var(--gray-200)' : '#bbf7d0'}`, borderRadius: '20px', padding: '2px 9px', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  {hideCompleted ? `Show ${completedCount} done` : 'Hide done'}
                </button>
              )}
              {selectedHasBookings && (
                <button onClick={() => setSelectedDay(null)} style={{ fontSize: '11px', color: 'var(--gray-400)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}>All ✕</button>
              )}
            </div>
          </div>
          <div style={{ marginTop: '10px', position: 'relative' }}>
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px', position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-400)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              value={tableSearch} onChange={e => { setTableSearch(e.target.value); setTablePage(0); }}
              placeholder="Search by name or phone…"
              style={{ width: '100%', padding: '8px 12px 8px 30px', fontSize: '13px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
            />
          </div>
        </div>
        {pagedRows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--gray-400)' }}>
            {tableSearch ? (
              <>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-500)' }}>No results for "{tableSearch}"</div>
                <button onClick={() => setTableSearch('')} style={{ marginTop: '8px', fontSize: '12px', color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>Clear search</button>
              </>
            ) : (
              <>
                <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5" style={{ width: '36px', height: '36px', margin: '0 auto 10px', display: 'block', color: 'var(--gray-300)' }}>
                  <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
                </svg>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-500)' }}>No bookings this month</div>
                <div style={{ fontSize: '12px', marginTop: '4px' }}>Click any day on the calendar to add a booking</div>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="cal-book-wrap">
              <table className="cal-book-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ background: 'var(--gray-50)', borderBottom: '1px solid var(--gray-200)' }}>
                    <th style={th}>Date</th>
                    <th style={th}>Client</th>
                    <th style={th}>Phone</th>
                    <th style={th}>Service</th>
                    <th style={th}>Time / Worker</th>
                    <th style={th}>Status</th>
                    <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map(b => (
                    <tr
                      key={b.id}
                      className="cal-book-tr"
                      onClick={() => b.isCalBooking ? setEditBooking(b) : goToLead(b.id)}
                      style={{ borderBottom: '1px solid var(--gray-100)', cursor: 'pointer', touchAction: 'manipulation' }}
                      onMouseEnter={e => { e.currentTarget.style.background = b.isCalBooking ? '#fefce8' : 'var(--gray-50)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                    >
                      <td className="cal-td-date" style={td}>
                        <div style={{ background: b.isCalBooking ? '#fefce8' : '#eff6ff', borderRadius: '8px', padding: '5px 10px', textAlign: 'center', display: 'inline-block', minWidth: '44px' }}>
                          <div style={{ fontSize: '9.5px', fontWeight: 700, color: b.isCalBooking ? '#92400e' : 'var(--primary)', textTransform: 'uppercase' }}>
                            {b.parsedDate.toLocaleDateString('en-AU', { month: 'short' })}
                          </div>
                          <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--gray-900)', lineHeight: 1.1 }}>{b.parsedDate.getDate()}</div>
                        </div>
                      </td>
                      <td className="cal-td-client" style={{ ...td, fontWeight: 600, color: 'var(--gray-900)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          {b.name}
                          {b.isCalBooking && b.bookingSource !== 'Lead' && <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '8px', background: '#fef3c7', color: '#92400e', flexShrink: 0 }}>MANUAL</span>}
                          {b.isCalBooking && b.bookingSource === 'Lead' && <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '8px', background: '#eff6ff', color: 'var(--primary)', flexShrink: 0 }}>BOOKED</span>}
                        </div>
                      </td>
                      <td className="cal-td-phone" style={{ ...td, color: 'var(--gray-600)' }}>{b.phone || '—'}</td>
                      <td className="cal-td-service" style={td}>
                        {(b.jobType || b.service)
                          ? <span style={{ fontSize: '11px', fontWeight: 600, padding: '2px 8px', borderRadius: '20px', background: '#eff6ff', color: 'var(--primary)', whiteSpace: 'nowrap' }}>{b.jobType || b.service}</span>
                          : <span style={{ color: 'var(--gray-400)' }}>—</span>
                        }
                      </td>
                      <td className="cal-td-time" style={{ ...td, color: 'var(--gray-600)', fontSize: '12px' }}>
                        {b.jobTime || b.assignedWorker
                          ? <div>
                              {b.jobTime && <div style={{ fontWeight: 600, color: 'var(--gray-800)' }}>{b.jobTime}</div>}
                              {b.assignedWorker && <div style={{ color: 'var(--gray-500)' }}>{b.assignedWorker}</div>}
                            </div>
                          : <span style={{ color: 'var(--gray-300)' }}>—</span>
                        }
                      </td>
                      <td className="cal-td-status" style={td}>
                        {b.isCalBooking ? (
                          <span style={{
                            fontSize: '10.5px', fontWeight: 700, padding: '2px 8px', borderRadius: '20px',
                            background: b.bookingStatus === 'Completed' ? '#f0fdf4' : b.bookingStatus === 'Cancelled' ? '#fef2f2' : '#fefce8',
                            color: b.bookingStatus === 'Completed' ? '#15803d' : b.bookingStatus === 'Cancelled' ? '#dc2626' : '#92400e',
                          }}>
                            {b.bookingStatus || 'Scheduled'}
                          </span>
                        ) : (
                          <span style={{ fontSize: '10.5px', fontWeight: 700, padding: '2px 8px', borderRadius: '20px', background: '#eff6ff', color: 'var(--primary)' }}>Lead</span>
                        )}
                      </td>
                      <td className="cal-td-amount" style={{ ...td, textAlign: 'right' }}>
                        <div style={{ fontWeight: 700, color: b.bookingStatus === 'Completed' ? '#15803d' : 'var(--primary)' }}>
                          {(b.amount > 0 || b.value > 0) ? `$${(b.amount || b.value || 0).toLocaleString()}` : '—'}
                        </div>
                        {b.upsellAmount > 0 && (
                          <div style={{ fontSize: '10px', color: '#d97706', fontWeight: 600 }}>+${b.upsellAmount} upsell</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', borderTop: '1px solid var(--gray-100)' }}>
                <button onClick={() => setTablePage(p => Math.max(0, p - 1))} disabled={safePage === 0} style={{ fontSize: '12px', fontWeight: 600, color: safePage === 0 ? 'var(--gray-300)' : 'var(--primary)', background: 'none', border: `1px solid ${safePage === 0 ? 'var(--gray-200)' : 'var(--primary)'}`, borderRadius: '6px', padding: '5px 12px', cursor: safePage === 0 ? 'default' : 'pointer', fontFamily: 'inherit' }}>← Prev</button>
                <span style={{ fontSize: '12px', color: 'var(--gray-500)', fontWeight: 600 }}>Page {safePage + 1} of {totalPages}</span>
                <button onClick={() => setTablePage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage === totalPages - 1} style={{ fontSize: '12px', fontWeight: 600, color: safePage === totalPages - 1 ? 'var(--gray-300)' : 'var(--primary)', background: 'none', border: `1px solid ${safePage === totalPages - 1 ? 'var(--gray-200)' : 'var(--primary)'}`, borderRadius: '6px', padding: '5px 12px', cursor: safePage === totalPages - 1 ? 'default' : 'pointer', fontFamily: 'inherit' }}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>

      {modalDay !== null && (
        <BookingModal
          year={year} month={month} day={modalDay}
          leads={leads} clients={clients}
          addCalBooking={addCalBooking}
          onClose={() => setModalDay(null)}
        />
      )}
      {editBooking && (
        <EditBookingModal
          booking={editBooking}
          leads={leads} clients={clients}
          onSave={data => { updateCalBooking(editBooking.id, data); setEditBooking(null); }}
          onComplete={data => handleComplete(editBooking, data)}
          onCancel={() => { removeCalBooking(editBooking.id); setEditBooking(null); }}
          onClose={() => setEditBooking(null)}
        />
      )}
    </div>
  );
}

const modalOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 2000, padding: '0', overflowY: 'auto' };
const fInput = { width: '100%', padding: '8px 11px', fontSize: '13px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', marginBottom: '10px' };
const fLbl   = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '5px', display: 'block' };
const th = { padding: '10px 14px', textAlign: 'left', fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.04em', whiteSpace: 'nowrap' };
const td = { padding: '11px 14px', color: 'var(--gray-700)', verticalAlign: 'middle' };
