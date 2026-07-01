import { useState, useEffect, useRef } from 'react';
import { useLeadsContext } from '../context/LeadsContext';

const mlbl = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '6px', display: 'block' };
const inp  = { width: '100%', padding: '10px 12px', fontSize: '14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };

// Known services — offered as quick-pick suggestions for line descriptions.
const SERVICE_SUGGESTIONS = ['Window Cleaning', 'Pressure Washing', 'Solar Panel', 'Other'];

export default function InvoiceModal() {
  const { invoiceModalId, invoiceModalLead, sendInvoice, closeInvoiceModal, showToast } = useLeadsContext();

  const [to, setTo]               = useState('');
  const [project, setProject]     = useState('');
  // Each invoice can now carry multiple service line items ({ description, amount }).
  const [lineItems, setLineItems] = useState([{ description: '', amount: '' }]);
  const [testEmail, setTestEmail] = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState('');
  // Only a click that BOTH starts and ends on the overlay should close the modal.
  // Selecting text in an input and releasing the mouse outside the modal fires an
  // overlay "click" — without this guard that would wrongly close the modal.
  const downOnOverlay = useRef(false);

  // Snapshot the lead so the modal NEVER loses the owner's typed inputs. The 30s
  // poll (or a leads reload) can momentarily make invoiceModalLead null/replace
  // it; without a snapshot the modal would unmount/reset and wipe the email.
  const [lead, setLead] = useState(null);
  useEffect(() => { if (invoiceModalLead) setLead(invoiceModalLead); }, [invoiceModalLead]);

  // Initialise the form ONCE per modal-open (keyed on invoiceModalId, not the
  // lead object). Opening a different lead re-inits; a poll/reload does not.
  useEffect(() => {
    if (!invoiceModalId) { setLead(null); return; }
    const l = invoiceModalLead;
    if (!l) return;
    setLead(l);
    setTo(l.email || '');
    setProject(l.address || '');
    const jobs = (l.jobTypes && l.jobTypes.length) ? l.jobTypes : [l.jobType || 'window cleaning'];
    setLineItems(jobs.map((j, idx) => ({ description: j, amount: idx === 0 ? String(l.invoice || l.value || '') : '' })));
    setTestEmail(l.email || '');
    setErr('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceModalId]);

  if (!invoiceModalId || !lead) return null;

  const alreadySent = lead.invoiceSent;

  const subtotal = lineItems.reduce((s, li) => s + (parseFloat(li.amount) || 0), 0);
  const gst = subtotal * 0.1;       // GST added 10% on top (amounts are GST-exclusive)
  const total = subtotal + gst;     // total due, GST inclusive

  const updateLine = (i, field, value) =>
    setLineItems(prev => prev.map((li, idx) => (idx === i ? { ...li, [field]: value } : li)));
  const addLine    = () => setLineItems(prev => [...prev, { description: '', amount: '' }]);
  const removeLine = i => setLineItems(prev => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));

  async function fire(test) {
    // Drop blank/zero rows; only real, priced services go on the invoice.
    const clean = lineItems
      .map(li => ({ description: (li.description || '').trim(), amount: parseFloat(li.amount) || 0 }))
      .filter(li => li.description && li.amount > 0);
    if (!test && (clean.length === 0 || total <= 0)) { setErr('Add at least one service with an amount'); return; }
    const recipient = test ? testEmail : to;
    if (!recipient) { setErr('Recipient email is required'); return; }
    setErr(''); setBusy(true);
    try {
      const res = await sendInvoice({
        leadId: lead.airtableId || lead.id,
        to: recipient,
        clientName: lead.name,
        project,
        lineItems: clean,
        description: clean[0]?.description || '', // back-compat: single-line fallback on the backend
        amount: total,
        test,
      });
      if (!res?.success) throw new Error(res?.error || 'Send failed');
      showToast(test ? `Test invoice sent to ${recipient} ✓` : `Invoice #${res.invoiceNumber} sent ✓`);
      // Only the real send closes the modal. A test keeps it open so the owner can
      // review the preview, then approve and do the actual send.
      if (!test) closeInvoiceModal();
    } catch (e) {
      setErr(e.message || 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 3000, overflowY: 'auto' }}
      onMouseDown={e => { downOnOverlay.current = e.target === e.currentTarget; }}
      onClick={e => { if (e.target === e.currentTarget && downOnOverlay.current && !busy) closeInvoiceModal(); }}
    >
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', boxShadow: '0 -8px 40px rgba(0,0,0,0.22)', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--gray-100)' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>Send Invoice</div>
            <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>{lead.name} · due on receipt</div>
          </div>
          <button onClick={closeInvoiceModal} disabled={busy} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--gray-400)', padding: '4px' }}>✕</button>
        </div>

        <div style={{ padding: '18px 20px' }}>
          {alreadySent && (
            <div style={{ fontSize: '12px', color: '#92400e', marginBottom: '14px', padding: '9px 11px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px' }}>
              ⚠️ This lead was already invoiced (#{lead.invoiceNumber}). A real send is blocked — use Send Test to re-preview.
            </div>
          )}

          <label style={mlbl}>To (client email)</label>
          <input style={{ ...inp, marginBottom: '12px' }} value={to} onChange={e => setTo(e.target.value)} placeholder="client@email.com" />

          <label style={mlbl}>Service address / project</label>
          <input style={{ ...inp, marginBottom: '12px' }} value={project} onChange={e => setProject(e.target.value)} placeholder="e.g. 1114 Gold Coast Hwy, Palm Beach" />

          <datalist id="invoice-service-options">
            {SERVICE_SUGGESTIONS.map(s => <option key={s} value={s} />)}
          </datalist>

          <label style={mlbl}>Services</label>
          {lineItems.map((li, i) => (
            <div key={i} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
              <input
                style={{ ...inp, flex: 2 }}
                list="invoice-service-options"
                value={li.description}
                onChange={e => updateLine(i, 'description', e.target.value)}
                placeholder="e.g. Window Cleaning"
              />
              <input
                style={{ ...inp, flex: 1, minWidth: 0 }}
                type="number"
                value={li.amount}
                onChange={e => updateLine(i, 'amount', e.target.value)}
                placeholder="0.00"
              />
              <button
                type="button"
                onClick={() => removeLine(i)}
                disabled={lineItems.length === 1}
                title="Remove line"
                style={{ flex: '0 0 auto', width: '34px', height: '38px', background: 'none', border: '1.5px solid var(--gray-200)', borderRadius: '8px', cursor: lineItems.length === 1 ? 'not-allowed' : 'pointer', color: 'var(--gray-400)', fontSize: '15px', fontFamily: 'inherit' }}
              >✕</button>
            </div>
          ))}

          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '14px' }}>
            <button
              type="button"
              onClick={addLine}
              style={{ background: 'none', border: 'none', color: '#0f766e', fontSize: '13px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', padding: '4px 0' }}
            >+ Add line</button>
            <div style={{ fontSize: '13px', color: 'var(--gray-600)', textAlign: 'right', minWidth: '160px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Subtotal</span><span>${subtotal.toFixed(2)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}><span>GST (10%)</span><span>${gst.toFixed(2)}</span></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', paddingTop: '4px', borderTop: '1px solid var(--gray-200)', color: 'var(--gray-900)', fontWeight: 700 }}><span>Total</span><span>${total.toFixed(2)}</span></div>
            </div>
          </div>

          {err && (
            <div style={{ fontSize: '12px', color: '#dc2626', marginBottom: '12px', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>{err}</div>
          )}

          <button
            onClick={() => fire(false)}
            disabled={busy || alreadySent}
            style={{ width: '100%', padding: '12px', background: alreadySent ? 'var(--gray-300)' : '#0f766e', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700, cursor: busy || alreadySent ? 'not-allowed' : 'pointer', fontFamily: 'inherit', minHeight: '44px' }}
          >
            {busy ? 'Sending…' : 'Send Invoice'}
          </button>

          <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px dashed var(--gray-200)' }}>
            <label style={mlbl}>Send a test (no invoice number used, lead not marked)</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input style={{ ...inp, flex: 1 }} value={testEmail} onChange={e => setTestEmail(e.target.value)} placeholder="test@email.com" />
              <button
                onClick={() => fire(true)}
                disabled={busy}
                style={{ padding: '0 16px', background: '#fff', color: '#0f766e', border: '1.5px solid #0f766e', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: busy ? 'not-allowed' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}
              >
                Send Test
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
