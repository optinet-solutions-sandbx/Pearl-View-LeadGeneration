import { useState, useRef, useEffect } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import { REFUSE_LABELS, COLS } from '../utils/constants';

// ── Aging timer helpers ───────────────────────────────────────────────────────
function getAge(dateObj) {
  if (!dateObj || dateObj.getTime() === 0) return null;
  const diff = Date.now() - dateObj.getTime();
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1)  return { label: 'Just now', ms: diff };
  if (h < 1)  return { label: `${m}m`,    ms: diff };
  if (d < 1)  return { label: `${h}h`,    ms: diff };
  return       { label: `${d}d`,           ms: diff };
}

function ageStyle(ms) {
  const h = ms / 3600000;
  if (h < 2) return { bg: '#f0fdf4', color: '#16a34a' };
  if (h < 6) return { bg: '#fffbeb', color: '#d97706' };
  return       { bg: '#fef2f2', color: '#dc2626' };
}

// ── Pipeline navigation maps ──────────────────────────────────────────────────
const NEXT_STATUS = { new: 'in_progress', in_progress: 'quote_sent', quote_sent: 'booked', booked: 'job_done' };
const PREV_STATUS = { in_progress: 'new', quote_sent: 'in_progress', booked: 'quote_sent', job_done: 'booked' };

export default function LeadCard({ lead }) {
  const {
    activeId, openPanel, toggleStar, changeStatus,
    renameLead, showToast,
  } = useLeadsContext();

  const [isEditing, setIsEditing] = useState(false);
  const [editName,  setEditName]  = useState('');
  const [swipeX,    setSwipeX]    = useState(0);
  const inputRef = useRef(null);
  const touchRef = useRef({ startX: 0, startY: 0, didSwipe: false });

  const THRESHOLD = 75;

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // ── Derived values ──────────────────────────────────────────────────────────
  const isCall = lead.hasCall;
  const lpName = lead.lp === 'LP2' ? 'Pearl View' : lead.lp === 'LP1' ? 'Crystal Pro' : null;

  // Aging timer — only for New Lead status
  const age    = lead.status === 'new' ? getAge(lead.dateObj) : null;
  const ageSty = age ? ageStyle(age.ms) : null;

  // Overdue follow-up
  const isOverdue = lead.followUp && new Date(lead.followUp) < new Date();

  const canMoveForward = !!NEXT_STATUS[lead.status];
  const canMoveBack    = !!PREV_STATUS[lead.status];

  // ── Swipe handlers ──────────────────────────────────────────────────────────
  function onTouchStart(e) {
    touchRef.current = {
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      didSwipe: false,
    };
  }

  function onTouchMove(e) {
    const dx = e.touches[0].clientX - touchRef.current.startX;
    const dy = Math.abs(e.touches[0].clientY - touchRef.current.startY);
    // Ignore vertical scrolls
    if (!touchRef.current.didSwipe && dy > 8 && dy > Math.abs(dx)) return;
    // Block direction if action not available
    if (dx > 0 && !canMoveForward) return;
    if (dx < 0 && !canMoveBack)    return;
    touchRef.current.didSwipe = true;
    if (dx > 0) setSwipeX(Math.min(THRESHOLD + 15, dx));
    else        setSwipeX(Math.max(-(THRESHOLD + 15), dx));
  }

  function onTouchEnd() {
    if (swipeX >= THRESHOLD && canMoveForward) {
      const next = NEXT_STATUS[lead.status];
      changeStatus(lead.id, next);
      const label = COLS.find(c => c.id === next)?.label || next;
      showToast(`Moved to ${label}`);
    } else if (swipeX <= -THRESHOLD && canMoveBack) {
      const prev = PREV_STATUS[lead.status];
      changeStatus(lead.id, prev);
      const label = COLS.find(c => c.id === prev)?.label || prev;
      showToast(`Moved back to ${label}`);
    }
    touchRef.current.didSwipe = false;
    setSwipeX(0);
  }

  function handleCardClick() {
    if (touchRef.current.didSwipe) return;
    openPanel(lead.id);
  }

  // ── Tag elements ────────────────────────────────────────────────────────────
  const srcLabel = (() => {
    if (isCall) return lpName ? `Call · ${lpName}` : 'Phone Call';
    if (lpName) return `Form · ${lpName}`;
    return lead.leadSource || 'Form';
  })();
  const srcTagClass = isCall ? 'tag-call' : lead.lp === 'LP1' ? 'tag-form1' : lead.lp === 'LP2' ? 'tag-form2' : 'tag-gray';
  const srcTag = <span className={`tag ${srcTagClass}`}>{srcLabel}</span>;

  const refuseTag = lead.status === 'refused' && lead.refuseReason
    ? <span className="tag" style={{ background: '#fee2e2', color: '#991b1b' }}>
        {REFUSE_LABELS[lead.refuseReason] || lead.refuseReason}
      </span>
    : null;

  const tagChip = lead.tag ? (
    <span className={`tag ${
      lead.tag.toLowerCase().includes('sent')     ? 'tag-sent'
      : lead.tag.toLowerCase().includes('tomorrow') ? 'tag-tomorrow'
      : 'tag-gray'
    }`}>{lead.tag}</span>
  ) : null;

  const shortSubject = (lead.subject || '').length > 90
    ? lead.subject.substring(0, 90) + '…'
    : lead.subject || '—';

  let valText = '';
  if (lead.status === 'job_done' && lead.paid && lead.paidAmount > 0) {
    valText = `Paid $${lead.paidAmount.toLocaleString()}`;
  } else if (lead.value > 0) {
    valText = `Est. $${lead.value.toLocaleString()}`;
  }

  const showView = lead.status === 'new' || lead.status === 'in_progress';
  const isActive = activeId === lead.id;

  // ── Drag handlers ───────────────────────────────────────────────────────────
  function handleStarClick(e) { e.stopPropagation(); toggleStar(lead.id); }

  function handleDblClick(e) {
    e.stopPropagation();
    setEditName(lead.name);
    setIsEditing(true);
  }

  function saveName() {
    const trimmed = editName.trim() || lead.name;
    renameLead(lead.id, trimmed);
    setIsEditing(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter')  { e.preventDefault(); saveName(); }
    if (e.key === 'Escape') { setIsEditing(false); }
  }

  function handleDragStart(e) {
    e.dataTransfer.setData('text/plain', lead.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => e.target.classList.add('dragging'), 0);
  }
  function handleDragEnd(e) { e.target.classList.remove('dragging'); }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative' }}>

      {/* ── Swipe-right: Move Forward (green, left side) ── */}
      {swipeX > 10 && (
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: '80px',
          background: '#16a34a', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 3,
        }}>
          <svg fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2.5" style={{ width: '18px', height: '18px' }}>
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
          <span style={{ color: '#fff', fontSize: '9px', fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase' }}>
            Move Up
          </span>
        </div>
      )}

      {/* ── Swipe-left: Move Back (amber, right side) ── */}
      {swipeX < -10 && (
        <div style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '80px',
          background: '#d97706', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 3,
        }}>
          <svg fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2.5" style={{ width: '18px', height: '18px' }}>
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          <span style={{ color: '#fff', fontSize: '9px', fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase' }}>
            Move Back
          </span>
        </div>
      )}

      {/* ── Card ── */}
      <div
        className={`card${isActive ? ' active' : ''}`}
        data-tour="lead-card"
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onClick={handleCardClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          transform: `translateX(${swipeX}px)`,
          transition: swipeX === 0 ? 'transform 0.2s ease' : 'none',
          touchAction: 'pan-y',
        }}
      >
        <div className="card-top">
          {isEditing ? (
            <input
              ref={inputRef}
              className="card-name-input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={saveName}
              onKeyDown={handleKeyDown}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className="card-name" onDoubleClick={handleDblClick} title="Double-click to rename">
              {lead.name}
            </span>
          )}
          <button className={`star${lead.starred ? ' on' : ''}`} onClick={handleStarClick}>
            {lead.starred ? '★' : '☆'}
          </button>
        </div>

        {/* Source + status tags */}
        <div className="tags">
          {srcTag}
          {tagChip}
          {refuseTag}
        </div>

        {/* Smart badges: aging, overdue */}
        {(age || isOverdue) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '5px' }}>
            {age && (
              <span style={{ fontSize: '9.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px', background: ageSty.bg, color: ageSty.color }}>
                ⏱ {age.label}
              </span>
            )}
            {isOverdue && (
              <span style={{ fontSize: '9.5px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px', background: '#fef2f2', color: '#dc2626' }}>
                📅 Follow Up Due
              </span>
            )}
          </div>
        )}

        <div className="card-sub">{shortSubject}</div>

        <div className="card-footer">
          <span className="card-val">{valText}</span>
          {lead.duration && (
            <span className="card-dur">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              {lead.duration}
            </span>
          )}
        </div>

        {showView && lead.phone && (
          <a
            href={`tel:${lead.phone}`}
            onClick={e => e.stopPropagation()}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              marginTop: '7px', fontSize: '11.5px', fontWeight: 600,
              color: 'var(--primary)', textDecoration: 'none',
            }}
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '12px', height: '12px', flexShrink: 0 }}>
              <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81 19.79 19.79 0 012 1.18 2 2 0 014 0h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 14.92z" transform="translate(1,1)"/>
            </svg>
            {lead.phone}
          </a>
        )}

        {lead.status === 'job_done' && !lead.paid && (
          <div style={{ marginTop: '8px', padding: '5px 10px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '6px', fontSize: '11px', fontWeight: 700, color: '#c2410c', display: 'flex', alignItems: 'center', gap: '5px' }}>
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '12px', height: '12px', flexShrink: 0 }}>
              <line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
            Collect Payment
          </div>
        )}

        <div className="prog">
          <div className="prog-fill" style={{ width: `${lead.progress}%` }}></div>
        </div>

        {showView && (
          <button className="view-btn" onClick={e => { e.stopPropagation(); openPanel(lead.id); }}>
            View Details
          </button>
        )}
      </div>
    </div>
  );
}
