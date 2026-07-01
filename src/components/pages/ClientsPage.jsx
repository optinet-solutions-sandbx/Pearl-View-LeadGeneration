import { useState, useMemo, useRef } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import { formatDate } from '../../utils/dateUtils';
import ClientDetailModal from '../ClientDetailModal';
import { overlayClose } from '../../utils/overlayClose';

const PAGE_SIZE = 10;

const iLbl   = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '5px', display: 'block' };
const iInput = { width: '100%', padding: '8px 10px', fontSize: '13px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', color: 'var(--gray-800)', background: '#fff' };

const SOURCE_OPTIONS = [
  { value: '',                   label: '— Unknown —' },
  { value: 'website-pearlview',  label: 'Pearl View Website' },
  { value: 'website-crystalpro', label: 'Crystal Pro Website' },
  { value: 'Phone Call',         label: 'Phone Call' },
  { value: 'Facebook',           label: 'Facebook' },
  { value: 'Google',             label: 'Google' },
  { value: 'Other',              label: 'Other' },
];

// Short labels for the badge shown on each client card
const SOURCE_BADGE = {
  'website-pearlview':  { label: 'Pearl View', bg: '#fdf4ff', color: '#7c3aed' },
  'website-crystalpro': { label: 'Crystal Pro', bg: '#eff6ff', color: '#2563eb' },
  'Phone Call':         { label: 'Phone', bg: '#f0fdfa', color: '#0d9488' },
  'Facebook':           { label: 'Facebook', bg: '#eff6ff', color: '#1877f2' },
  'Google':             { label: 'Google', bg: '#fef2f2', color: '#dc2626' },
  'Other':              { label: 'Other', bg: '#f9fafb', color: '#6b7280' },
};

function deriveLpFromSource(src) {
  if (!src) return null;
  const s = src.toLowerCase().replace(/[\s-]/g, '');
  if (s.includes('crystalpro') || s.includes('crystal')) return 'LP1';
  if (s.includes('pearlview')  || s.includes('pearl'))   return 'LP2';
  return null;
}

// ── Add Client modal ──────────────────────────────────────────────────────────
function AddClientModal({ onClose, onSave }) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', city: '', address: '', notes: '', leadSource: '' });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  function setF(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSave() {
    if (!form.name.trim()) { setErr('Client name is required'); return; }
    setSaving(true);
    setErr('');
    await onSave({
      name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(),
      city: form.city.trim(), address: form.address.trim(), notes: form.notes.trim(),
      leadSource: form.leadSource,
    });
    setSaving(false);
    onClose();
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2100, padding: '16px' }}
      {...overlayClose(onClose)}
    >
      <div style={{ background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '420px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 24px 64px rgba(0,0,0,0.22)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--gray-100)' }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--gray-900)' }}>Add Client</div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '20px', color: 'var(--gray-400)', padding: '4px', lineHeight: 1 }}>✕</button>
        </div>
        <div style={{ padding: '16px 20px', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={iLbl}>Client Name <span style={{ color: '#dc2626' }}>*</span></label>
              <input value={form.name} onChange={e => setF('name', e.target.value)} style={iInput} placeholder="Full name" autoFocus />
            </div>
            <div>
              <label style={iLbl}>Phone</label>
              <input value={form.phone} onChange={e => setF('phone', e.target.value)} style={iInput} placeholder="0400 000 000" />
            </div>
            <div>
              <label style={iLbl}>Email</label>
              <input value={form.email} onChange={e => setF('email', e.target.value)} style={iInput} placeholder="email@example.com" />
            </div>
            <div>
              <label style={iLbl}>City</label>
              <input value={form.city} onChange={e => setF('city', e.target.value)} style={iInput} placeholder="e.g. Brisbane" />
            </div>
            <div>
              <label style={iLbl}>Property Type</label>
              <input value={form.address} onChange={e => setF('address', e.target.value)} style={iInput} placeholder="e.g. Residential" />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={iLbl}>Lead Source</label>
              <select value={form.leadSource} onChange={e => setF('leadSource', e.target.value)} style={{ ...iInput, cursor: 'pointer' }}>
                {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={iLbl}>Notes</label>
              <textarea value={form.notes} onChange={e => setF('notes', e.target.value)} style={{ ...iInput, minHeight: '60px', resize: 'vertical' }} placeholder="Internal notes…" />
            </div>
          </div>
          {err && <div style={{ fontSize: '12px', color: '#dc2626', marginBottom: '10px', padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px' }}>{err}</div>}
          <button
            onClick={handleSave}
            disabled={saving}
            style={{ width: '100%', padding: '10px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', fontFamily: 'inherit' }}
          >
            {saving ? 'Saving…' : 'Add Client'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Client card with swipe-left-to-archive ────────────────────────────────────
const STATUS_DOT = {
  new:         '#2563eb',
  in_progress: '#d97706',
  quote_sent:  '#7c3aed',
  booked:      '#2563eb',
  job_done:    '#16a34a',
  refused:     '#dc2626',
  scam:        '#6b7280',
};

function ClientCard({ c, onSelect, onArchive, onRestore, onPermDelete, isArchived, localSearch }) {
  const [swipeX, setSwipeX] = useState(0);
  const touchRef = useRef({ startX: 0, startY: 0, didSwipe: false });
  const THRESHOLD = 70;

  function onTouchStart(e) {
    touchRef.current = { startX: e.touches[0].clientX, startY: e.touches[0].clientY, didSwipe: false };
  }

  function onTouchMove(e) {
    const dx = e.touches[0].clientX - touchRef.current.startX;
    const dy = Math.abs(e.touches[0].clientY - touchRef.current.startY);
    if (!touchRef.current.didSwipe && dy > 8 && dy > Math.abs(dx)) return;
    if (dx > 0) return; // only left swipe
    touchRef.current.didSwipe = true;
    setSwipeX(Math.max(-(THRESHOLD + 20), dx));
  }

  function onTouchEnd() {
    if (swipeX <= -THRESHOLD && !isArchived) {
      onArchive(c.airtableId);
    }
    touchRef.current.didSwipe = false;
    setSwipeX(0);
  }

  function handleClick() {
    if (touchRef.current.didSwipe) return;
    if (!isArchived) onSelect(c);
  }

  const srcMeta = SOURCE_BADGE[c.leadSource] || null;

  return (
    <div style={{ position: 'relative', marginBottom: '8px' }}>
      {/* Swipe-left archive background */}
      {swipeX < -10 && (
        <div style={{
          position: 'absolute', right: 0, top: 0, bottom: 0, width: '80px',
          background: '#dc2626', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '3px',
          borderRadius: '0 10px 10px 0',
        }}>
          <svg fill="none" viewBox="0 0 24 24" stroke="#fff" strokeWidth="2" style={{ width: '16px', height: '16px' }}>
            <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
          </svg>
          <span style={{ color: '#fff', fontSize: '9px', fontWeight: 800, letterSpacing: '.04em', textTransform: 'uppercase' }}>
            {swipeX <= -THRESHOLD ? 'Release' : 'Archive'}
          </span>
        </div>
      )}

      <div
        onClick={handleClick}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        style={{
          position: 'relative', zIndex: 1,
          background: '#fff', border: '1px solid var(--gray-200)', borderRadius: '10px',
          padding: '14px 16px', display: 'flex', alignItems: 'center', gap: '14px',
          cursor: isArchived ? 'default' : 'pointer',
          transform: `translateX(${swipeX}px)`,
          transition: swipeX === 0 ? 'transform 0.2s ease' : 'none',
          touchAction: 'pan-y',
          opacity: isArchived ? 0.8 : 1,
        }}
      >
        {/* Avatar */}
        <div style={{
          width: '40px', height: '40px', borderRadius: '50%', background: 'var(--blue-100)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '15px', fontWeight: 700, color: 'var(--primary)', flexShrink: 0, position: 'relative',
        }}>
          {(c.name || '?').charAt(0).toUpperCase()}
          {c.latestStatus && (
            <span style={{
              position: 'absolute', bottom: 0, right: 0,
              width: '10px', height: '10px', borderRadius: '50%', border: '2px solid #fff',
              background: STATUS_DOT[c.latestStatus] || '#9ca3af',
            }} />
          )}
        </div>

        {/* Main info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '13.5px', fontWeight: 600, color: 'var(--gray-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {localSearch ? highlightMatch(c.name, localSearch) : c.name}
            </span>
            {srcMeta && (
              <span style={{ fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '6px', flexShrink: 0, background: srcMeta.bg, color: srcMeta.color }}>
                {srcMeta.label}
              </span>
            )}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--gray-500)', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {c.phone && <span>{c.phone}</span>}
            {c.city  && <span>· {c.city}</span>}
            {!c.phone && !c.city && c.email && <span>{c.email}</span>}
          </div>
        </div>

        {/* Right side */}
        {isArchived ? (
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={e => { e.stopPropagation(); onRestore(c.airtableId); }}
              style={{ padding: '5px 10px', fontSize: '11px', fontWeight: 700, borderRadius: '6px', border: '1.5px solid #16a34a', background: '#f0fdf4', color: '#16a34a', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Restore
            </button>
            <button
              onClick={e => { e.stopPropagation(); if (window.confirm('Permanently delete this client?')) onPermDelete(c.airtableId, true); }}
              style={{ padding: '5px 10px', fontSize: '11px', fontWeight: 700, borderRadius: '6px', border: '1.5px solid #dc2626', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Delete
            </button>
          </div>
        ) : (
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'flex-end', marginBottom: '4px' }}>
              {c.latestValue > 0 && (
                <span style={{ fontSize: '11.5px', fontWeight: 700, color: '#0d9488' }}>${c.latestValue.toLocaleString()}</span>
              )}
              {c.leadCount > 0 && (
                <span style={{ fontSize: '10.5px', fontWeight: 700, background: '#eff6ff', color: 'var(--primary)', borderRadius: '20px', padding: '1px 7px' }}>
                  {c.leadCount} lead{c.leadCount !== 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--gray-400)' }}>{c.date ? formatDate(c.date) : '—'}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ClientsPage() {
  const { leads, clients, archivedClients, archiveClient, restoreClient, permanentDeleteClient, syncClientsFromLeads, upsertClient, showToast } = useLeadsContext();
  const [selectedClient, setSelectedClient] = useState(null);
  const [page, setPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [syncing, setSyncing] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [localSearch, setLocalSearch] = useState('');

  // Build client list from Clients table only (phone-deduped)
  const mergedClients = useMemo(() => {
    const result = [];
    const seenPhones = new Set();
    const seenNames  = new Set();

    clients.forEach(c => {
      const normalPhone = (c.phone || '').replace(/\s/g, '').toLowerCase();
      const normalName  = (c.name  || '').toLowerCase().trim();

      if (normalPhone && seenPhones.has(normalPhone)) return;
      if (!normalPhone && normalName && seenNames.has(normalName)) return;

      const matchingLeads = leads.filter(l => {
        if (normalPhone) {
          const lp = (l.phone || '').replace(/\s/g, '').toLowerCase();
          if (lp && lp === normalPhone) return true;
        }
        return l.name?.toLowerCase().trim() === normalName;
      }).sort((a, b) => b.dateObj - a.dateObj);

      const latestLead = matchingLeads[0];
      result.push({
        ...c,
        date:         latestLead?.date   || '',
        dateObj:      latestLead?.dateObj || new Date(0),
        leadCount:    matchingLeads.length,
        latestStatus: latestLead?.status || null,
        latestValue:  latestLead?.value  || 0,
        lp:           latestLead?.lp || deriveLpFromSource(c.leadSource),
      });

      if (normalPhone) seenPhones.add(normalPhone);
      if (normalName)  seenNames.add(normalName);
    });

    return result.sort((a, b) => b.dateObj - a.dateObj);
  }, [clients, leads]);

  // Build dynamic source tabs from actual client data
  const sourceCounts = useMemo(() => {
    const counts = {};
    mergedClients.forEach(c => {
      const src = c.leadSource || '';
      counts[src] = (counts[src] || 0) + 1;
    });
    return counts;
  }, [mergedClients]);

  const SOURCE_TABS = useMemo(() => {
    const tabs = [{ key: 'all', label: 'All', count: mergedClients.length }];
    SOURCE_OPTIONS.filter(o => o.value).forEach(opt => {
      const count = sourceCounts[opt.value] || 0;
      if (count > 0) tabs.push({ key: opt.value, label: SOURCE_BADGE[opt.value]?.label || opt.label, count });
    });
    tabs.push({ key: 'archived', label: 'Archived', count: (archivedClients || []).length });
    return tabs;
  }, [sourceCounts, mergedClients, archivedClients]);

  // Apply search + source filter
  const filtered = useMemo(() => {
    let result = sourceFilter === 'archived' ? (archivedClients || []) : mergedClients;
    if (sourceFilter !== 'all' && sourceFilter !== 'archived') {
      result = result.filter(c => (c.leadSource || '') === sourceFilter);
    }
    const term = localSearch.trim().toLowerCase();
    if (!term) return result;
    return result.filter(c =>
      (c.name  || '').toLowerCase().includes(term) ||
      (c.email || '').toLowerCase().includes(term) ||
      (c.phone || '').toLowerCase().includes(term) ||
      (c.city  || '').toLowerCase().includes(term)
    );
  }, [mergedClients, archivedClients, localSearch, sourceFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function pageNumbers() {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages = new Set([1, totalPages, safePage, safePage - 1, safePage + 1]);
    return [...pages].filter(p => p >= 1 && p <= totalPages).sort((a, b) => a - b);
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const count = await syncClientsFromLeads();
      if (count === 0) showToast('All clients already synced ✓');
      else showToast(`${count} client${count !== 1 ? 's' : ''} added to Clients table ✓`);
    } catch {
      showToast('Sync failed — check connection');
    }
    setSyncing(false);
  }

  async function handleAddClient(data) {
    await upsertClient({ name: data.name, phone: data.phone, email: data.email, city: data.city, address: data.address, notes: data.notes, leadSource: data.leadSource });
    showToast('Client added ✓');
  }

  function handleArchiveClient(airtableId) {
    archiveClient(airtableId);
    showToast('Client archived ✓');
    setSelectedClient(null);
  }

  return (
    <div className="page">
      {/* ── Header ── */}
      <div style={{ marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <div>
            <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)', lineHeight: 1.2 }}>Clients</div>
            <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>
              {mergedClients.length} client{mergedClients.length !== 1 ? 's' : ''}
            </div>
          </div>
          {/* Action buttons — inline with title */}
          <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
            <button
              onClick={handleSync}
              disabled={syncing}
              style={{
                padding: '7px 12px', fontSize: '12px', fontWeight: 700, borderRadius: '8px',
                border: '1.5px solid var(--gray-200)', background: '#fff',
                cursor: syncing ? 'not-allowed' : 'pointer',
                color: syncing ? 'var(--gray-400)' : 'var(--gray-700)', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: '5px',
              }}
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '12px', height: '12px', flexShrink: 0 }}>
                <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/>
              </svg>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
            <button
              onClick={() => setShowAddModal(true)}
              style={{
                padding: '7px 12px', fontSize: '12px', fontWeight: 700, borderRadius: '8px',
                border: 'none', background: 'var(--primary)', color: '#fff',
                cursor: 'pointer', fontFamily: 'inherit',
                display: 'flex', alignItems: 'center', gap: '5px',
              }}
            >
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '12px', height: '12px', flexShrink: 0 }}>
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add Client
            </button>
          </div>
        </div>
      </div>

      {/* ── Source filter tabs (scrollable) ── */}
      {/* Outer div handles scroll; inner div is the flex row (avoids height-collapse bug with overflow-x on flex items) */}
      <div style={{ overflowX: 'auto', marginBottom: '10px', paddingBottom: '4px', WebkitOverflowScrolling: 'touch', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: '6px', width: 'max-content' }}>
        {SOURCE_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => { setSourceFilter(tab.key); setPage(1); }}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '6px 12px', fontSize: '12px', fontWeight: 700, borderRadius: '20px',
              border: '1.5px solid', cursor: 'pointer', fontFamily: 'inherit',
              whiteSpace: 'nowrap', flexShrink: 0, transition: 'all .15s',
              borderColor: sourceFilter === tab.key ? 'var(--primary)' : 'var(--gray-200)',
              background:  sourceFilter === tab.key ? 'var(--primary)' : '#fff',
              color:       sourceFilter === tab.key ? '#fff' : 'var(--gray-600)',
            }}
          >
            {tab.label}
            <span style={{
              fontSize: '10px', fontWeight: 800,
              background: sourceFilter === tab.key ? 'rgba(255,255,255,0.25)' : 'var(--gray-100)',
              color:      sourceFilter === tab.key ? '#fff' : 'var(--gray-500)',
              borderRadius: '20px', padding: '0px 5px', lineHeight: '16px',
            }}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>
      </div>

      {/* ── Search ── */}
      <div style={{ position: 'relative', marginBottom: '12px' }}>
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', width: '14px', height: '14px', color: 'var(--gray-400)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
        </svg>
        <input
          type="text"
          value={localSearch}
          onChange={e => { setLocalSearch(e.target.value); setPage(1); }}
          placeholder="Search by name, phone, city…"
          style={{ width: '100%', padding: '8px 12px 8px 32px', fontSize: '13px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', background: 'var(--gray-50)' }}
        />
        {localSearch && (
          <button onClick={() => { setLocalSearch(''); setPage(1); }} style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gray-400)', fontSize: '15px', lineHeight: 1, padding: '2px 4px' }}>✕</button>
        )}
      </div>

      {localSearch && (
        <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginBottom: '10px' }}>
          {filtered.length} result{filtered.length !== 1 ? 's' : ''} for "{localSearch}"
        </div>
      )}

      {/* ── Client list ── */}
      {paged.length === 0 ? (
        <div style={{ color: 'var(--gray-400)', fontSize: '13px', textAlign: 'center', padding: '40px' }}>
          {localSearch ? `No clients match "${localSearch}"` : 'No clients found'}
        </div>
      ) : (
        paged.map(c => (
          <ClientCard
            key={c.airtableId || c.id}
            c={c}
            isArchived={sourceFilter === 'archived'}
            localSearch={localSearch}
            onSelect={setSelectedClient}
            onArchive={id => { archiveClient(id); showToast('Client archived ✓'); }}
            onRestore={id => { restoreClient(id); showToast('Client restored ✓'); }}
            onPermDelete={(id, confirmed) => {
              if (confirmed) { permanentDeleteClient(id, true); showToast('Client permanently deleted'); }
            }}
          />
        ))
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="col-modal-footer" style={{ marginTop: '8px' }}>
          <span className="pg-info">
            Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="pg-controls">
            <button className="pg-btn" disabled={safePage === 1} onClick={() => setPage(p => p - 1)}>‹ Prev</button>
            {pageNumbers().reduce((acc, pg, idx, arr) => {
              if (idx > 0 && pg - arr[idx - 1] > 1)
                acc.push(<span key={`gap-${pg}`} className="pg-gap">…</span>);
              acc.push(
                <button key={pg} className={`pg-btn pg-num${safePage === pg ? ' pg-active' : ''}`} onClick={() => setPage(pg)}>
                  {pg}
                </button>
              );
              return acc;
            }, [])}
            <button className="pg-btn" disabled={safePage === totalPages} onClick={() => setPage(p => p + 1)}>Next ›</button>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showAddModal && (
        <AddClientModal
          onClose={() => setShowAddModal(false)}
          onSave={handleAddClient}
        />
      )}
      {selectedClient && (
        <ClientDetailModal
          client={selectedClient}
          onClose={() => setSelectedClient(null)}
          onArchive={handleArchiveClient}
        />
      )}
    </div>
  );
}

function highlightMatch(text, term) {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#fef08a', borderRadius: '2px', padding: '0 1px' }}>
        {text.slice(idx, idx + term.length)}
      </mark>
      {text.slice(idx + term.length)}
    </>
  );
}
