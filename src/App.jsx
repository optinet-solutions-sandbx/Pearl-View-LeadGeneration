import { LeadsProvider, useLeadsContext } from './context/LeadsContext';
import { useEffect } from 'react';
import Sidebar, { MobileBottomNav } from './components/Sidebar';
import TopBar from './components/TopBar';
import DetailPanel from './components/DetailPanel';
import NewLeadModal from './components/NewLeadModal';
import RefuseModal from './components/RefuseModal';
import QuoteTransferModal from './components/QuoteTransferModal';
import BookModal from './components/BookModal';
import QuoteSendModal from './components/QuoteSendModal';
import InvoiceModal from './components/InvoiceModal';
import Toast from './components/Toast';
import LoadingOverlay from './components/LoadingOverlay';
import LeadsPage from './components/pages/LeadsPage';
import OverviewPage from './components/pages/OverviewPage';
import ClientsPage from './components/pages/ClientsPage';
import DeletedHistoryPage from './components/pages/DeletedHistoryPage';
import CalendarPage from './components/pages/CalendarPage';
import ExpensesPage from './components/pages/ExpensesPage';
import ReportsPage from './components/pages/ReportsPage';
import ContactsPage from './components/pages/ContactsPage';
import BroadcastPage from './components/pages/BroadcastPage';

function PageBody() {
  const { currentPage } = useLeadsContext();

  switch (currentPage) {
    case 'overview':        return <OverviewPage />;
    case 'clients':         return <ClientsPage />;
    case 'deleted-history': return <DeletedHistoryPage />;
    case 'calendar':        return <CalendarPage />;
    case 'expenses':        return <ExpensesPage />;
    case 'reports':         return <ReportsPage />;
    case 'contacts':        return <ContactsPage />;
    case 'broadcast':       return <BroadcastPage />;
    case 'leads':
    default:                return <LeadsPage />;
  }
}

function Dashboard() {
  const { isLoading, currentPage, setModalOpen } = useLeadsContext();

  // Hide bottom nav + FAB when mobile keyboard is open (input focused)
  useEffect(() => {
    function onFocusIn(e) {
      if (e.target.matches('input, textarea, select')) {
        document.body.classList.add('keyboard-open');
      }
    }
    function onFocusOut(e) {
      if (e.target.matches('input, textarea, select')) {
        setTimeout(() => {
          if (!document.querySelector('input:focus, textarea:focus, select:focus')) {
            document.body.classList.remove('keyboard-open');
          }
        }, 100);
      }
    }
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  return (
    <div className="shell">
      {isLoading && <LoadingOverlay />}
      <Sidebar />
      <div className="main">
        <TopBar />
        <PageBody />
      </div>
      <DetailPanel />
      <NewLeadModal />
      <RefuseModal />
      <QuoteTransferModal />
      <BookModal />
      <QuoteSendModal />
      <InvoiceModal />
      <Toast />
      <MobileBottomNav />
      {/* FAB — mobile-only, Leads page only */}
      {currentPage === 'leads' && (
        <button className="fab" onClick={() => setModalOpen(true)} aria-label="New Lead">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '22px', height: '22px' }}>
            <path d="M12 5v14M5 12h14"/>
          </svg>
        </button>
      )}
    </div>
  );
}

export default function App() {
  return (
    <LeadsProvider>
      <Dashboard />
    </LeadsProvider>
  );
}
