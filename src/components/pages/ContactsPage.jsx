import { useEffect, useMemo, useState } from 'react';

const IS_LOCAL  = import.meta.env.DEV;
const PAGE_SIZE = 25;

function formatAuPhone(num) {
  if (!num) return '';
  let s = String(num);
  if (s.startsWith('61')) s = '0' + s.slice(2);
  if (s.length === 10 && s.startsWith('0')) {
    return s.slice(0, 4) + ' ' + s.slice(4, 7) + ' ' + s.slice(7);
  }
  return s;
}

function fullName(c) {
  const fn = (c.first_name || '').trim();
  const ln = (c.last_name  || '').trim();
  if (fn || ln) return `${fn} ${ln}`.trim();
  return '';
}

// `field_1` = inquiry date we set during sync (YYYY-MM-DD).
// `added`   = when MM added the contact to the broadcast list.
function contactDate(c) {
  if (c.field_1 && c.field_1.trim()) return c.field_1;
  if (c.added)   return c.added.slice(0, 10);
  return '';
}

async function fetchContacts() {
  // Cache-bust + force fresh fetch — iOS Safari aggressively caches API
  // responses even with Cache-Control: max-age=0, and a stale bundle on
  // the user's phone could otherwise hit a cached empty result.
  const cacheBust = `_t=${Date.now()}`;
  const fetchOpts = {
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
  };

  if (IS_LOCAL) {
    const limit = 200;
    let offset = 0;
    const all = [];
    while (true) {
      const r = await fetch(
        `/mm-api/v1/list-contacts?list_id=${import.meta.env.VITE_MM_LIST_ID}&limit=${limit}&offset=${offset}&${cacheBust}`,
        fetchOpts
      );
      if (!r.ok) throw new Error(`MM ${r.status}`);
      const d = await r.json();
      const batch = d.results || [];
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return all;
  }

  const r = await fetch(`/api/mm-list-contacts?${cacheBust}`, fetchOpts);
  if (!r.ok) throw new Error(`API ${r.status}`);
  const d = await r.json();
  return d.results || [];
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState(null);
  const [search, setSearch]     = useState('');
  const [sortKey, setSortKey]   = useState('date');
  const [sortDir, setSortDir]   = useState('desc');
  const [page, setPage]         = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchContacts()
      .then(d => { if (!cancelled) setContacts(d); })
      .catch(e => { if (!cancelled) setErr(e.message || 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  function refresh() { setReloadKey(k => k + 1); }

  // Reset to first page whenever filter/sort changes
  useEffect(() => { setPage(1); }, [search, sortKey, sortDir]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? contacts.filter(c => {
          const name = fullName(c).toLowerCase();
          const phone = String(c.number || '').toLowerCase();
          return name.includes(q) || phone.includes(q);
        })
      : contacts;

    const arr = [...list];
    arr.sort((a, b) => {
      let av, bv;
      if (sortKey === 'name') {
        av = fullName(a).toLowerCase() || '￿';
        bv = fullName(b).toLowerCase() || '￿';
      } else {
        av = contactDate(a) || '0000';
        bv = contactDate(b) || '0000';
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [contacts, search, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const startIdx   = (safePage - 1) * PAGE_SIZE;
  const pageRows   = filtered.slice(startIdx, startIdx + PAGE_SIZE);

  const namedCount = contacts.filter(c => fullName(c)).length;

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'date' ? 'desc' : 'asc');
    }
  }

  function SortArrow({ active, dir }) {
    if (!active) return <span style={{ opacity: 0.3, marginLeft: '4px', fontSize: '10px' }}>↕</span>;
    return <span style={{ marginLeft: '4px', color: 'var(--primary)' }}>{dir === 'asc' ? '↑' : '↓'}</span>;
  }

  if (loading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
        <div style={{ color: 'var(--gray-400)', fontSize: '14px' }}>Loading contacts from Mobile Message…</div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="page">
        <div style={{ background: '#fef2f2', border: '1.5px solid #fecaca', color: '#991b1b', borderRadius: '12px', padding: '16px 18px', fontSize: '13px' }}>
          <div style={{ fontWeight: 700, marginBottom: '6px' }}>Couldn't load contacts</div>
          <div style={{ marginBottom: '12px', color: '#7f1d1d' }}>{err}</div>
          <button
            onClick={refresh}
            style={{
              padding: '8px 16px',
              background: '#991b1b',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  // Compact page-number list — show ellipsis for long ranges
  function pageNumbers() {
    const nums = [];
    const max = totalPages;
    if (max <= 7) {
      for (let i = 1; i <= max; i++) nums.push(i);
      return nums;
    }
    const around = new Set([1, 2, max - 1, max, safePage - 1, safePage, safePage + 1]);
    let last = 0;
    [...around].sort((a, b) => a - b).forEach(n => {
      if (n < 1 || n > max) return;
      if (last && n - last > 1) nums.push('…');
      nums.push(n);
      last = n;
    });
    return nums;
  }

  return (
    <div className="page">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Contacts</div>
          <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>
            Mobile Message broadcast list — every phone that goes through the system lands here automatically.
          </div>
        </div>
        <button
          onClick={refresh}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '8px 14px',
            background: '#fff',
            color: 'var(--gray-700)',
            border: '1.5px solid var(--gray-200)',
            borderRadius: '8px',
            fontSize: '12.5px',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            minHeight: '36px',
            flexShrink: 0,
          }}
          aria-label="Refresh contacts"
        >
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '14px', height: '14px' }}>
            <path d="M23 4v6h-6M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
          Refresh
        </button>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '10px', flexShrink: 0 }}>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--gray-900)', marginTop: '4px' }}>{contacts.length}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>in broadcast list</div>
        </div>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Named</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#0d9488', marginTop: '4px' }}>{namedCount}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>with name attached</div>
        </div>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Unnamed</div>
          <div style={{ fontSize: '22px', fontWeight: 800, color: '#c2410c', marginTop: '4px' }}>{contacts.length - namedCount}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>phone-only (legacy)</div>
        </div>
      </div>

      {/* Search */}
      <div style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: '12px', padding: '12px 14px', flexShrink: 0 }}>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by name or phone…"
          style={{
            width: '100%',
            padding: '10px 14px',
            border: '1.5px solid var(--gray-200)',
            borderRadius: '8px',
            fontSize: '15px',
            fontFamily: 'inherit',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
        {search && (
          <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '8px' }}>
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="contacts-table">
        {/* Sortable header row — visible on both desktop and mobile */}
        <div className="contacts-row contacts-header-row">
          <div className="contacts-cell-name sortable" onClick={() => toggleSort('name')}>
            Name <SortArrow active={sortKey === 'name'} dir={sortDir} />
          </div>
          <div className="contacts-cell-phone phone-header">Phone</div>
          <div className="contacts-cell-date sortable" onClick={() => toggleSort('date')}>
            Date <SortArrow active={sortKey === 'date'} dir={sortDir} />
          </div>
        </div>

        {/* Rows */}
        {pageRows.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--gray-400)', fontSize: '14px' }}>
            {search ? 'No contacts match your search.' : 'No contacts yet — add a lead to populate this list.'}
          </div>
        )}
        {pageRows.map((c, i) => {
          const name = fullName(c);
          const date = contactDate(c);
          return (
            <div className="contacts-row" key={c.contact_id || c.number || i}>
              <div className={`contacts-cell-name${name ? '' : ' unnamed'}`}>
                {name || '— Unnamed —'}
              </div>
              <div className="contacts-cell-phone">
                {formatAuPhone(c.number)}
              </div>
              <div className={`contacts-cell-date${date ? '' : ' empty'}`}>
                {date || '—'}
              </div>
            </div>
          );
        })}

        {/* Pagination footer */}
        {filtered.length > PAGE_SIZE && (
          <div className="contacts-pager">
            <div className="contacts-pager-info">
              {startIdx + 1}–{Math.min(startIdx + PAGE_SIZE, filtered.length)} of {filtered.length}
            </div>
            <div className="contacts-pager-nav">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={safePage === 1}
                aria-label="Previous page"
              >
                ‹ Prev
              </button>
              <div className="contacts-pager-numbers">
                {pageNumbers().map((n, idx) =>
                  n === '…' ? (
                    <span key={'gap-' + idx} className="contacts-pager-ellipsis">…</span>
                  ) : (
                    <button
                      key={n}
                      onClick={() => setPage(n)}
                      className={n === safePage ? 'active' : ''}
                    >
                      {n}
                    </button>
                  )
                )}
              </div>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={safePage === totalPages}
                aria-label="Next page"
              >
                Next ›
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
