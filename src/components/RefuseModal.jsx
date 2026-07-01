import { useLeadsContext } from '../context/LeadsContext';
import { overlayClose } from '../utils/overlayClose';

export default function RefuseModal() {
  const { refuseModalId, confirmRefuse, closeRefuseModal } = useLeadsContext();
  if (!refuseModalId) return null;

  return (
    <div className="overlay open" {...overlayClose(closeRefuseModal)}>
      <div className="modal" style={{ maxWidth: '340px', padding: '24px' }}>
        <div className="modal-title">Refusal Reason</div>
        <p style={{ fontSize: '12.5px', color: 'var(--gray-500)', marginBottom: '18px' }}>
          Why did this lead not proceed?
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button className="refuse-opt" onClick={() => confirmRefuse('too_expensive')}>
            💰 Too Expensive
          </button>
          <button className="refuse-opt" onClick={() => confirmRefuse('competition')}>
            🏆 Went with Competition
          </button>
          <button className="refuse-opt" onClick={() => confirmRefuse('no_answer')}>
            📵 No Answer / Ghosted
          </button>
          <button className="refuse-opt" onClick={() => confirmRefuse('other')}>
            ❓ Other
          </button>
        </div>
        <div className="modal-footer" style={{ marginTop: '14px' }}>
          <button className="btn-cancel" onClick={closeRefuseModal}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
