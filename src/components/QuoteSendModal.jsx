import { useState } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import { overlayClose } from '../utils/overlayClose';

const mlbl = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '6px', display: 'block' };

export default function QuoteSendModal() {
  const { quoteSendModalId, quoteSendLeadName, confirmQuoteSend, closeQuoteSendModal } = useLeadsContext();
  const [amount, setAmount] = useState('');
  const [err, setErr] = useState('');

  if (!quoteSendModalId) return null;

  function handleSubmit() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { setErr('Please enter a valid amount'); return; }
    setErr('');
    setAmount('');
    confirmQuoteSend(amt);
  }

  function handleClose() {
    setAmount('');
    setErr('');
    closeQuoteSendModal();
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 3000, overflowY: 'auto' }}
      {...overlayClose(handleClose)}
    >
      <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', width: '100%', maxWidth: '480px', boxShadow: '0 -8px 40px rgba(0,0,0,0.22)', paddingBottom: 'env(safe-area-inset-bottom, 16px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--gray-100)' }}>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>Send Quote</div>
            {quoteSendLeadName && (
              <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>{quoteSendLeadName}</div>
            )}
          </div>
          <button onClick={handleClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', color: 'var(--gray-400)', padding: '4px' }}>✕</button>
        </div>
        <div style={{ padding: '18px 20px' }}>
          <label style={mlbl}>Estimated Amount ($)</label>
          <div style={{ position: 'relative', marginBottom: '14px' }}>
            <span style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--gray-500)', fontWeight: 700, fontSize: '15px' }}>$</span>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') handleClose(); }}
              style={{ width: '100%', padding: '10px 12px 10px 28px', fontSize: '17px', fontWeight: 700, border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
            />
          </div>
          {err && (
            <div style={{ fontSize: '12px', color: '#dc2626', marginBottom: '12px', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>
              {err}
            </div>
          )}
          <button
            onClick={handleSubmit}
            style={{ width: '100%', padding: '11px', background: '#1e293b', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
          >
            Send Quote
          </button>
        </div>
      </div>
    </div>
  );
}
