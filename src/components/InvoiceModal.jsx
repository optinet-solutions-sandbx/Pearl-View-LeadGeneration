import { useState, useEffect } from 'react';
import { useLeadsContext } from '../context/LeadsContext';

const mlbl = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '6px', display: 'block' };
const inp  = { width: '100%', padding: '10px 12px', fontSize: '14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' };

export default function InvoiceModal() {
  const { invoiceModalLead, sendInvoice, closeInvoiceModal, showToast } = useLeadsContext();

  const [to, setTo]               = useState('');
  const [project, setProject]     = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount]       = useState('');
  const [testEmail, setTestEmail] = useState('');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState('');

  const lead = invoiceModalLead;

  useEffect(() => {
    if (!lead) return;
    setTo(lead.email || '');
    setProject(lead.address || '');
    setDescription(lead.jobType || 'window cleaning');
    setAmount(String(lead.invoice || lead.value || ''));
    setTestEmail(lead.email || '');
    setErr('');
  }, [lead]);

  if (!lead) return null;

  const alreadySent = lead.invoiceSent;

  async function fire(test) {
    const amt = parseFloat(amount);
    if (!test && (!amt || amt <= 0)) { setErr('Enter a valid invoice amount'); return; }
    const recipient = test ? testEmail : to;
    if (!recipient) { setErr('Recipient email is required'); return; }
    setErr(''); setBusy(true);
    try {
      const res = await sendInvoice({
        leadId: lead.airtableId || lead.id,
        to: recipient,
        clientName: lead.name,
        project,
        description,
        amount: amt || 0,
        test,
      });
      if (!res?.success) throw new Error(res?.error || 'Send failed');
      showToast(test ? `Test invoice sent to ${recipient} ✓` : `Invoice #${res.invoiceNumber} sent ✓`);
      closeInvoiceModal();
    } catch (e) {
      setErr(e.message || 'Send failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 3000, overflowY: 'auto' }}
      onClick={e => { if (e.target === e.currentTarget && !busy) closeInvoiceModal(); }}
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

          <div style={{ display: 'flex', gap: '10px', marginBottom: '12px' }}>
            <div style={{ flex: 2 }}>
              <label style={mlbl}>Description</label>
              <input style={inp} value={description} onChange={e => setDescription(e.target.value)} placeholder="window cleaning" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={mlbl}>Amount ($)</label>
              <input style={inp} type="number" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
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
