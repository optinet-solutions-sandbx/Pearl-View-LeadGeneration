import { useState, useRef } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import StatsRow from '../StatsRow';
import KanbanBoard from '../KanbanBoard';

const PTR_THRESHOLD = 65;

export default function LeadsPage() {
  const { refetch, readOnly } = useLeadsContext();
  const [pullY,      setPullY]      = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const touchRef = useRef({ startY: 0, active: false });

  function onTouchStart(e) {
    if (window.scrollY > 4) return;
    touchRef.current = { startY: e.touches[0].clientY, active: true };
  }

  function onTouchMove(e) {
    if (!touchRef.current.active) return;
    const dy = e.touches[0].clientY - touchRef.current.startY;
    if (dy <= 0) { touchRef.current.active = false; return; }
    setPullY(Math.min(dy * 0.5, PTR_THRESHOLD + 15));
  }

  async function onTouchEnd() {
    if (!touchRef.current.active) { setPullY(0); return; }
    touchRef.current.active = false;
    if (pullY >= PTR_THRESHOLD) {
      setRefreshing(true);
      setPullY(0);
      await refetch();
      setRefreshing(false);
    } else {
      setPullY(0);
    }
  }

  const showPtr = pullY > 8 || refreshing;
  const ptrLabel = refreshing ? 'Refreshing…' : pullY >= PTR_THRESHOLD ? 'Release to refresh' : 'Pull to refresh';

  return (
    <div
      className="page"
      style={{ position: 'relative' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {showPtr && (
        <div className="ptr-indicator" style={{ transform: `translateY(${refreshing ? 0 : pullY - PTR_THRESHOLD}px)` }}>
          <svg
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"
            className={refreshing ? 'refresh-animate' : ''}
            style={{ width: '16px', height: '16px' }}
          >
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          <span>{ptrLabel}</span>
        </div>
      )}
      <KanbanBoard />
      {!readOnly && <StatsRow />}
    </div>
  );
}
