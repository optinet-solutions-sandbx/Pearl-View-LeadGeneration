export default function BroadcastConfirmModal({
  open,
  message,
  sender,
  senderLabel,
  recipientCount,
  parts,
  totalSmsUnits,
  scheduledFor,
  sending,
  onConfirm,
  onCancel,
}) {
  if (!open) return null;

  // Render the message preview with placeholders highlighted so the owner
  // sees what {first_name} etc. will look like before sending.
  const preview = String(message || '').replace(
    /(\{[a-z_0-9]+\})/g,
    '⟨$1⟩'
  );

  const scheduledLabel = scheduledFor
    ? new Date(scheduledFor).toLocaleString('en-AU', {
        weekday: 'short', day: 'numeric', month: 'short',
        hour: 'numeric', minute: '2-digit',
      })
    : null;

  return (
    <div
      className="overlay open"
      onClick={e => e.target === e.currentTarget && !sending && onCancel()}
    >
      <div className="modal" style={{ maxWidth: '460px', padding: '24px' }}>
        <div className="modal-title">
          {scheduledFor ? 'Schedule Broadcast?' : 'Send Broadcast Now?'}
        </div>
        <p style={{ fontSize: '13px', color: 'var(--gray-600)', marginTop: '4px', marginBottom: '18px' }}>
          This will {scheduledFor ? 'schedule the message for delivery to' : 'send the message to'}{' '}
          <strong style={{ color: 'var(--gray-900)' }}>{recipientCount} recipient{recipientCount === 1 ? '' : 's'}</strong>.
          Unsubscribed numbers are automatically excluded by Mobile Message.
        </p>

        {/* Summary chips */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '14px' }}>
          <span style={{ background: '#f1f5f9', color: 'var(--gray-700)', padding: '6px 10px', borderRadius: '6px', fontSize: '11.5px', fontWeight: 600 }}>
            From: {senderLabel || sender}
          </span>
          <span style={{ background: '#f1f5f9', color: 'var(--gray-700)', padding: '6px 10px', borderRadius: '6px', fontSize: '11.5px', fontWeight: 600 }}>
            {parts} SMS part{parts === 1 ? '' : 's'} each
          </span>
          <span style={{ background: '#ecfeff', color: '#0e7490', padding: '6px 10px', borderRadius: '6px', fontSize: '11.5px', fontWeight: 600 }}>
            {totalSmsUnits} total SMS units
          </span>
          {scheduledLabel && (
            <span style={{ background: '#fef3c7', color: '#92400e', padding: '6px 10px', borderRadius: '6px', fontSize: '11.5px', fontWeight: 600 }}>
              ⏰ {scheduledLabel}
            </span>
          )}
        </div>

        {/* Message preview */}
        <div style={{
          background: '#f8fafc',
          border: '1.5px solid var(--gray-200)',
          borderRadius: '10px',
          padding: '14px',
          fontSize: '13px',
          color: 'var(--gray-800)',
          lineHeight: '1.5',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: '180px',
          overflowY: 'auto',
        }}>
          {preview}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '6px' }}>
          Placeholders like <code style={{ fontFamily: 'monospace' }}>⟨{'{first_name}'}⟩</code> are substituted per recipient by Mobile Message.
        </div>

        <div className="modal-footer" style={{ marginTop: '20px', display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button
            className="btn-cancel"
            onClick={onCancel}
            disabled={sending}
            style={{ opacity: sending ? 0.5 : 1, cursor: sending ? 'not-allowed' : 'pointer' }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={sending}
            style={{
              padding: '9px 20px',
              background: sending ? 'var(--gray-400)' : '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: '7px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: sending ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              minWidth: '120px',
            }}
          >
            {sending
              ? 'Sending…'
              : scheduledFor ? 'Schedule' : `Send to ${recipientCount}`}
          </button>
        </div>
      </div>
    </div>
  );
}
