import { useEffect, useMemo, useState } from 'react';

const IS_LOCAL = import.meta.env.DEV;

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

// Pick the most meaningful date for sorting/display:
//  - `field_1` is the inquiry/lead-intake date we set during sync (YYYY-MM-DD).
//  - `added`   is when MM added the contact to the broadcast list.
// Fall back to `added` for pre-existing MM contacts where field_1 is blank.
function contactDate(c) {
  if (c.field_1 && c.field_1.trim()) return c.field_1;
  if (c.added)   return c.added.slice(0, 10);
  return '';
}

async function fetchContacts() {
  const url = IS_LOCAL ? '/mm-api/v1/list-contacts' : '/api/mm-list-contacts';
  if (IS_LOCAL) {
    // Proxy injects auth, but we still need list_id + pagination
    const all = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const r = await fetch(`${url}?list_id=${import.meta.env.VITE_MM_LIST_ID}&limit=${limit}&offset=${offset}`);
      if (!r.ok) break;
      const d = await r.json();
      const batch = d.results || [];
      all.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }
    return all;
  }
  const r = await fetch(url);
  if (!r.ok) return [];
  const d = await r.json();
  return d.results || [];
}

export default function ContactsPage() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState(null);
  const [search, setSearch]     = useState('');
  const [sortKey, setSortKey]   = useState('date');  // 'date' | 'name'
  const [sortDir, setSortDir]   = useState('desc');  // 'asc' | 'desc'

  useEffect(() => {
    fetchContacts()
      .then(setContacts)
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

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
        av = fullName(a).toLowerCase() || '￿'; // empty names sort last
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
    if (!active) return <span style={{ opacity: 0.25, marginLeft: '4px' }}>↕</span>;
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
        <div style={{ background: '#fef2f2', border: '1.5px solid #fecaca', color: '#991b1b', borderRadius: '12px', padding: '16px', fontSize: '13px' }}>
          Couldn't load contacts: {err}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {/* Header */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '16px' }}>
        <div>
          <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Contacts</div>
          <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>
            Mobile Message broadcast list — every phone that goes through the system lands here automatically.
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total Contacts</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--gray-900)', marginTop: '4px' }}>{contacts.length}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>in broadcast list</div>
        </div>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Named</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#0d9488', marginTop: '4px' }}>{namedCount}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>with first/last name</div>
        </div>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Unnamed</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#c2410c', marginTop: '4px' }}>{contacts.length - namedCount}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>phone only — pre-existing MM contacts</div>
        </div>
      </div>

      {/* Search */}
      <div style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: '12px', padding: '14px 16px', marginBottom: '12px' }}>
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
            fontSize: '14px',
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
      <div style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: '12px', overflow: 'hidden' }}>
        {/* Header row */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(140px, 1.4fr) minmax(140px, 1.6fr) minmax(110px, 1fr)',
          padding: '12px 16px',
          borderBottom: '1.5px solid var(--gray-100)',
          background: '#f8fafc',
          fontSize: '11px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.05em',
          color: 'var(--gray-500)',
        }}>
          <div
            onClick={() => toggleSort('name')}
            style={{ cursor: 'pointer', userSelect: 'none' }}
            title="Sort by name"
          >
            Name <SortArrow active={sortKey === 'name'} dir={sortDir} />
          </div>
          <div>Phone</div>
          <div
            onClick={() => toggleSort('date')}
            style={{ cursor: 'pointer', userSelect: 'none' }}
            title="Sort by date"
          >
            Lead Date <SortArrow active={sortKey === 'date'} dir={sortDir} />
          </div>
        </div>

        {/* Rows */}
        {filtered.length === 0 && (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--gray-400)', fontSize: '14px' }}>
            {search ? 'No contacts match your search.' : 'No contacts yet — add a lead to populate this list.'}
          </div>
        )}
        {filtered.map((c, i) => {
          const name = fullName(c);
          const date = contactDate(c);
          return (
            <div
              key={c.contact_id || c.number || i}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(140px, 1.4fr) minmax(140px, 1.6fr) minmax(110px, 1fr)',
                padding: '12px 16px',
                borderBottom: i === filtered.length - 1 ? 'none' : '1px solid var(--gray-100)',
                alignItems: 'center',
                fontSize: '13.5px',
                color: 'var(--gray-800)',
              }}
            >
              <div style={{ fontWeight: name ? 600 : 400, color: name ? 'var(--gray-900)' : 'var(--gray-400)' }}>
                {name || '— Unnamed —'}
              </div>
              <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '13px', color: 'var(--gray-700)' }}>
                {formatAuPhone(c.number)}
              </div>
              <div style={{ color: date ? 'var(--gray-600)' : 'var(--gray-300)', fontSize: '12.5px' }}>
                {date || '—'}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
