import { useLeadsContext } from '../context/LeadsContext';
import { overlayClose } from '../utils/overlayClose';

export default function QuoteTransferModal() {
  const {
    quoteTransferModalId,
    quoteTransferLeadValue,
    confirmQuoteTransfer,
    closeQuoteTransferModal,
  } = useLeadsContext();

  if (!quoteTransferModalId) return null;

  return (
    <div
      className="overlay open"
      {...overlayClose(closeQuoteTransferModal)}
    >
      <div className="modal" style={{ maxWidth: '380px' }}>
        <h3 style={{ margin: '0 0 10px', fontSize: '16px', fontWeight: 700, color: 'var(--gray-900)' }}>
          Moving Back from Quote Sent
        </h3>
        {quoteTransferLeadValue > 0 && (
          <p style={{ margin: '0 0 8px', fontSize: '13px', color: 'var(--gray-600)' }}>
            This lead has an existing estimation of{' '}
            <strong style={{ color: 'var(--primary)' }}>
              ${quoteTransferLeadValue.toLocaleString()}
            </strong>.
          </p>
        )}
        <p style={{ margin: '0 0 18px', fontSize: '13px', color: 'var(--gray-600)' }}>
          Would you like to keep or remove the estimation?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={() => confirmQuoteTransfer(false)}
            style={{
              width: '100%', padding: '11px', background: 'var(--primary)', color: '#fff',
              border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Keep Estimation
          </button>
          <button
            onClick={() => confirmQuoteTransfer(true)}
            style={{
              width: '100%', padding: '11px', background: '#fff', color: '#dc2626',
              border: '1.5px solid #fecaca', borderRadius: '8px', fontSize: '14px', fontWeight: 700,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            Remove Estimation
          </button>
          <button
            onClick={closeQuoteTransferModal}
            className="btn-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
