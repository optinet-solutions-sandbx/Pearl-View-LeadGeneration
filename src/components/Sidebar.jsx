import { useLeadsContext } from '../context/LeadsContext';

export const PAGE_TITLES = {
  leads:            'Leads Dashboard',
  overview:         'Overview',
  clients:          'Clients',
  'deleted-history':'Deleted History',
  calendar:         'Calendar',
  expenses:         'Expenses',
  reports:          'Reports',
  contacts:         'Contacts',
  broadcast:        'Broadcast SMS',
};

// ── Mobile bottom navigation bar ─────────────────────────────────────────────
export function MobileBottomNav() {
  const { leads, currentPage, setCurrentPage, setSearchTerm, closePanel, sidebarOpen, toggleSidebar } = useLeadsContext();

  function navigate(page) {
    const dest = currentPage === 'leads' && page === 'leads' ? 'overview' : page;
    setCurrentPage(dest);
    setSearchTerm('');
    closePanel();
  }

  const tabs = [
    { page: 'overview', label: 'Overview', icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '20px', height: '20px' }}>
        <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    )},
    { page: 'leads', label: 'Leads', badge: leads.length || null, icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '20px', height: '20px' }}>
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
      </svg>
    )},
    { page: 'clients', label: 'Clients', icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '20px', height: '20px' }}>
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
      </svg>
    )},
    { page: 'calendar', label: 'Calendar', icon: (
      <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '20px', height: '20px' }}>
        <rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
      </svg>
    )},
  ];

  return (
    <nav className="mobile-bottom-nav">
      {tabs.map(t => (
        <button
          key={t.page}
          onClick={() => navigate(t.page)}
          className={`mobile-nav-tab${currentPage === t.page ? ' active' : ''}`}
        >
          <div className="mobile-nav-icon">
            {t.icon}
            {t.badge && <span className="mobile-nav-badge">{t.badge > 99 ? '99+' : t.badge}</span>}
          </div>
          <span className="mobile-nav-label">{t.label}</span>
        </button>
      ))}
      {/* More tab — opens sidebar for Reports, Expenses, Deleted History */}
      <button
        onClick={toggleSidebar}
        className={`mobile-nav-tab${sidebarOpen ? ' active' : ''}`}
      >
        <div className="mobile-nav-icon">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" style={{ width: '20px', height: '20px' }}>
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </div>
        <span className="mobile-nav-label">More</span>
      </button>
    </nav>
  );
}

export default function Sidebar() {
  const { leads, deletedLeads, currentPage, setCurrentPage, setSearchTerm, closePanel, sidebarOpen, closeSidebar } = useLeadsContext();

  function navigate(page) {
    const dest = currentPage === 'leads' && page === 'leads' ? 'overview' : page;
    setCurrentPage(dest);
    setSearchTerm('');
    closePanel();
    closeSidebar();
  }

  const navItem = (page, label, icon) => (
    <div
      className={`nav-item${currentPage === page ? ' active' : ''}`}
      onClick={() => navigate(page)}
    >
      {icon}
      {label}
      {page === 'leads' && (
        <span className="nav-badge">{leads.length || '—'}</span>
      )}
      {page === 'deleted-history' && deletedLeads.length > 0 && (
        <span className="nav-badge" style={{ background: '#fee2e2', color: '#dc2626' }}>
          {deletedLeads.length}
        </span>
      )}
    </div>
  );

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={closeSidebar} />
      )}

      <aside className={`sidebar${sidebarOpen ? ' open' : ''}`}>
        <div className="logo">
          <div className="logo-icon">PV</div>
          <div>
            <span className="logo-name">Pearl View</span>
            <span className="logo-sub">Lead Management</span>
          </div>
        </div>
        <nav className="nav">
          <div className="nav-lbl">Main</div>
          {navItem('overview', 'Overview',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1"/>
              <rect x="14" y="3" width="7" height="7" rx="1"/>
              <rect x="3" y="14" width="7" height="7" rx="1"/>
              <rect x="14" y="14" width="7" height="7" rx="1"/>
            </svg>
          )}
          {navItem('leads', 'Leads',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/>
            </svg>
          )}
          {navItem('clients', 'Clients',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
              <circle cx="9" cy="7" r="4"/>
              <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
            </svg>
          )}
          {navItem('deleted-history', 'Deleted History',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          )}
          {navItem('calendar', 'Calendar',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="4" width="18" height="18" rx="2"/>
              <path d="M16 2v4M8 2v4M3 10h18"/>
            </svg>
          )}
          {navItem('expenses', 'Expenses',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="12" y1="1" x2="12" y2="23"/>
              <path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
          )}
          {navItem('reports', 'Reports',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
            </svg>
          )}
          {navItem('contacts', 'Contacts',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 00-3-3.87M4 21v-2a4 4 0 014-4h4a4 4 0 014 4v2"/>
              <circle cx="10" cy="7" r="4"/>
              <path d="M16 3.13a4 4 0 010 7.75"/>
            </svg>
          )}
          {navItem('broadcast', 'Broadcast SMS',
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M3 5h12a4 4 0 014 4v0a4 4 0 01-4 4H9l-6 4V5z"/>
              <line x1="7" y1="9" x2="13" y2="9"/>
            </svg>
          )}
        </nav>
        <div className="sidebar-footer" />
      </aside>
    </>
  );
}
