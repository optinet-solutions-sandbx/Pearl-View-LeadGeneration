import { useLeadsContext } from '../context/LeadsContext';
import { overlayClose } from '../utils/overlayClose';

export default function QuoteChangeModal() {
  const { quoteModalId, confirmQuoteChange, closeQuoteModal, leads } = useLeadsContext();
  if (!quoteModalId) return null;

  const lead = leads.find(l => l.id === quoteModalId);
  const amount = lead?.value > 0 ? `$${lead.value}` : 'a quote amount';

  return (
    <div className="overlay open" {...overlayClose(closeQuoteModal)}>
      <div className="modal" style={{ maxWidth: '340px', padding: '24px' }}>
        <div className="modal-title">Quote Amount</div>
        <p style={{ fontSize: '12.5px', color: 'var(--gray-500)', marginBottom: '18px' }}>
          This lead has {amount} saved. What would you like to do with it?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button className="refuse-opt" onClick={() => confirmQuoteChange(true)}>
            Keep quote amount
          </button>
          <button className="refuse-opt" onClick={() => confirmQuoteChange(false)}>
            Clear quote amount
          </button>
        </div>
        <div className="modal-footer" style={{ marginTop: '14px' }}>
          <button className="btn-cancel" onClick={closeQuoteModal}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
