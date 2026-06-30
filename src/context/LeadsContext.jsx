import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLeads } from '../hooks/useLeads';

const LeadsContext = createContext(null);

export function LeadsProvider({ children }) {
  const {
    leads, deletedLeads, calBookings, clients, isLoading, fetchLeads,
    changeStatus, toggleStar, saveNote, saveJobType,
    savePaidInfo, saveCity, saveJobDate, saveEmail, saveQuoteAmount, clearQuoteAmount,
    renameLead, setRefuseReason,
    archiveLead, permanentDelete, recoverLead, addLead,
    addCalBooking, removeCalBooking, updateCalBooking, recordBookingPayment,
    deletePayment, syncToClients, upsertClient, syncClientsFromLeads, updateClient,
    archivedClients, archiveClient, restoreClient, permanentDeleteClient,
  } = useLeads();

  const [activeId, setActiveId]       = useState(null);
  const [searchTerm, setSearchTerm]   = useState('');
  const [currentPage, setCurrentPage] = useState('leads');
  const [toast, setToast]             = useState(null);
  const [isModalOpen, setModalOpen]   = useState(false);
  const [statFilter, setStatFilter]   = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Guided tutorial (spotlight tour) state
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const startTutorial = useCallback(() => setTutorialOpen(true), []);
  const stopTutorial  = useCallback(() => setTutorialOpen(false), []);

  // Refuse modal state
  const [refuseModalId, setRefuseModalId]             = useState(null);
  const [refuseModalPrevStatus, setRefuseModalPrevStatus] = useState(null);

  // Quote-transfer modal state (when moving away from quote_sent)
  const [quoteTransferModalId,      setQuoteTransferModalId]      = useState(null);
  const [quoteTransferTargetStatus, setQuoteTransferTargetStatus] = useState(null);
  const [quoteTransferLeadValue,    setQuoteTransferLeadValue]    = useState(0);

  // Book modal state (when setting status → booked)
  const [bookModalId, setBookModalId] = useState(null);

  // Quote-send modal state (when changing status → quote_sent via swipe/drag)
  const [quoteSendModalId, setQuoteSendModalId] = useState(null);

  // Invoice modal state (opens after a lead is marked Job Done — Review & Send)
  const [invoiceModalId, setInvoiceModalId] = useState(null);
  const openInvoiceModal  = useCallback((id) => setInvoiceModalId(id), []);
  const closeInvoiceModal = useCallback(() => setInvoiceModalId(null), []);

  // POST to the Cloud Run /send-invoice endpoint. Derives the URL from
  // VITE_WEBHOOK_URL (…/notify-lead → …/send-invoice) unless VITE_INVOICE_URL is set.
  const sendInvoice = useCallback(async (payload) => {
    const base = import.meta.env.VITE_INVOICE_URL
      || (import.meta.env.VITE_WEBHOOK_URL || '').replace('/notify-lead', '/send-invoice');
    if (!base) throw new Error('Invoice endpoint not configured (VITE_WEBHOOK_URL)');
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Send failed (${r.status})`);
    // On a real send, re-read leads so the UI reflects Invoice Sent/Number
    if (!payload.test && data.invoiceNumber) {
      fetchLeads({ silent: true }).catch(() => {});
    }
    return data;
  }, [fetchLeads]);

  useEffect(() => {
    fetchLeads().catch(() => showToast('Failed to load data — check console'));
  }, [fetchLeads]);

  // Poll Airtable every 30s to pick up status changes made directly in Airtable
  useEffect(() => {
    const id = setInterval(() => {
      fetchLeads({ silent: true }).catch(() => {});
    }, 30_000);
    return () => clearInterval(id);
  }, [fetchLeads]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2700);
  }, []);

  const openPanel  = useCallback((id) => setActiveId(id), []);
  const closePanel = useCallback(() => setActiveId(null), []);

  const toggleSidebar = useCallback(() => setSidebarOpen(v => !v), []);
  const closeSidebar  = useCallback(() => setSidebarOpen(false), []);

  // Auto-launch the tutorial once for a brand-new user, after the first data
  // load finishes so the real UI is on screen to be highlighted.
  const autoTourFired = useRef(false);
  useEffect(() => {
    if (autoTourFired.current || isLoading) return;
    let seen = false;
    try { seen = !!localStorage.getItem('pvl_tutorial_done'); } catch { /* ignore */ }
    if (seen) { autoTourFired.current = true; return; }
    autoTourFired.current = true;
    const t = setTimeout(() => setTutorialOpen(true), 900);
    return () => clearTimeout(t);
  }, [isLoading]);

  // Central status change handler — enforces all business rules:
  // 1. 'refused'        → show RefuseModal first
  // 2. job_done + paid  → block (must delete payment first)
  // 3. quote_sent → in_progress/new → show QuoteTransferModal
  // 4. refused → other → clear Refusal Reason first
  const handleChangeStatus = useCallback(async (id, status) => {
    const lead = leads.find(l => l.id === id);
    if (!lead) return;

    // No-op: same status
    if (lead.status === status) return;

    // Rule: Job Done is locked once a payment is recorded
    if (lead.status === 'job_done' && lead.paid) {
      showToast('Status locked — payment already recorded');
      return;
    }

    // Rule: 'booked' → show booking modal to capture date/time/worker
    if (status === 'booked') {
      setBookModalId(id);
      return;
    }

    // Rule: → quote_sent always asks for quote amount first
    if (status === 'quote_sent') {
      setQuoteSendModalId(id);
      return;
    }

    // Rule: 'refused' always shows the reason modal first
    if (status === 'refused') {
      setRefuseModalPrevStatus(lead.status);
      setRefuseModalId(id);
      return;
    }

    // Intercept quote_sent → in_progress or new: ask about the estimation
    if (lead.status === 'quote_sent' && (status === 'in_progress' || status === 'new')) {
      setQuoteTransferModalId(id);
      setQuoteTransferTargetStatus(status);
      setQuoteTransferLeadValue(lead.value || 0);
      return;
    }

    // Clear Refusal Reason when moving away from refused
    if (lead.status === 'refused') {
      await setRefuseReason(id, '');
    }

    const result = await changeStatus(id, status);
    if (result === 'error') { showToast('Failed to save — check your connection'); return; }
    showToast('Status updated ✓');
    // Review & Send: marking Job Done pops the invoice preview (skip if already invoiced)
    if (status === 'job_done') {
      const lead = leads.find(l => l.id === id);
      if (!lead?.invoiceSent) setInvoiceModalId(id);
    }
  }, [changeStatus, showToast, leads, setRefuseReason]);

  const confirmRefuse = useCallback(async (reason) => {
    if (!refuseModalId) return;
    // Sequential: patch Refusal Reason first, then patch Lead Status
    await setRefuseReason(refuseModalId, reason);
    const result = await changeStatus(refuseModalId, 'refused');
    if (result === 'error') showToast('Failed to save — check your connection');
    else showToast('Status updated ✓');
    setRefuseModalId(null);
    setRefuseModalPrevStatus(null);
  }, [refuseModalId, changeStatus, setRefuseReason, showToast]);

  const closeRefuseModal = useCallback(() => {
    setRefuseModalId(null);
    setRefuseModalPrevStatus(null);
  }, []);

  // Confirm booking: status → booked + Scheduled calBooking. Revenue only recorded when Job Done.
  const confirmBook = useCallback(async (bookingData) => {
    if (!bookModalId) return;
    const id = bookModalId;
    setBookModalId(null);
    const result = await changeStatus(id, 'booked');
    if (result === 'error') { showToast('Failed to save — check your connection'); return; }
    const lead = leads.find(l => l.id === id);
    if (lead && bookingData.date) {
      await addCalBooking({
        clientName:     lead.name,
        phone:          lead.phone || '',
        city:           lead.city  || '',
        service:        lead.jobType || 'Window Cleaning',
        date:           bookingData.date,
        jobTime:        bookingData.jobTime || '',
        assignedWorker: bookingData.worker  || '',
        amount:         bookingData.amount || lead.value || 0,
        bookingStatus:  'Scheduled',
        linkedLeadId:   id,
      });
      saveJobDate(id, bookingData.date);
    }
    showToast('Lead booked ✓ — added to Calendar');
  }, [bookModalId, changeStatus, leads, addCalBooking, saveJobDate, showToast]);

  const closeBookModal = useCallback(() => setBookModalId(null), []);

  // Send quote: save amount then change status to quote_sent (bypasses interceptor)
  const sendQuoteAndChangeStatus = useCallback(async (id, amount) => {
    await saveQuoteAmount(id, amount);
    const result = await changeStatus(id, 'quote_sent');
    if (result === 'error') showToast('Failed to save — check your connection');
    else showToast('Quote sent ✓');
  }, [saveQuoteAmount, changeStatus, showToast]);

  const confirmQuoteSend = useCallback(async (amount) => {
    if (!quoteSendModalId) return;
    const id = quoteSendModalId;
    setQuoteSendModalId(null);
    await sendQuoteAndChangeStatus(id, amount);
  }, [quoteSendModalId, sendQuoteAndChangeStatus]);

  const closeQuoteSendModal = useCallback(() => setQuoteSendModalId(null), []);

  // Confirm moving a quote_sent lead back — optionally deleting the estimation
  const confirmQuoteTransfer = useCallback(async (shouldDeleteQuote) => {
    if (!quoteTransferModalId) return;
    const id = quoteTransferModalId;
    const targetStatus = quoteTransferTargetStatus;
    setQuoteTransferModalId(null);
    setQuoteTransferTargetStatus(null);
    setQuoteTransferLeadValue(0);
    if (shouldDeleteQuote) await clearQuoteAmount(id);
    const result = await changeStatus(id, targetStatus);
    if (result === 'error') showToast('Failed to save — check your connection');
    else if (result === 'ok') showToast('Status updated ✓');
  }, [quoteTransferModalId, quoteTransferTargetStatus, changeStatus, clearQuoteAmount, showToast]);

  const closeQuoteTransferModal = useCallback(() => {
    setQuoteTransferModalId(null);
    setQuoteTransferTargetStatus(null);
    setQuoteTransferLeadValue(0);
  }, []);

  const handleToggleStar = useCallback((id) => toggleStar(id), [toggleStar]);

  const handleSaveNote = useCallback((id, note) => {
    saveNote(id, note);
    // Sync to Clients table
    const lead = leads.find(l => l.id === id);
    if (lead?.phone) syncToClients(lead.phone, { 'Notes': note }, { notes: note });
  }, [saveNote, leads, syncToClients]);

  const handleSaveJobType = useCallback((id, jobType) => {
    saveJobType(id, jobType);
    // Sync the primary job type to the Clients table (Clients 'Property Type'
    // stays single-select — only the lead carries the full multi-selection).
    const arr = Array.isArray(jobType) ? jobType : (jobType ? [jobType] : []);
    const primary = arr[0] || '';
    const lead = leads.find(l => l.id === id);
    if (lead?.phone) syncToClients(lead.phone, { 'Property Type': primary }, { jobType: primary, jobTypes: arr });
  }, [saveJobType, leads, syncToClients]);

  const handleSavePaidInfo = useCallback(async (id, paid, paidAmount, paymentMethod) => {
    const result = await savePaidInfo(id, paid, paidAmount, paymentMethod);
    if (!result?.success && result !== true) {
      showToast('Failed to save payment — check your connection');
      return false;
    }
    const wasJobDone = result?.wasJobDone ?? result === true;
    if (paid && paidAmount > 0 && !wasJobDone) {
      // S3: payment recorded but job not done yet — auto-advance to In Progress if still New
      const lead = leads.find(l => l.id === id);
      if (lead?.status === 'new') {
        await changeStatus(id, 'in_progress');
        showToast('Payment recorded · Status → In Progress');
      } else {
        showToast('Payment recorded ✓');
      }
    } else {
      showToast('Payment recorded ✓');
    }
    // Re-fetch after a short delay to confirm Revenue record was written
    setTimeout(() => fetchLeads({ silent: true }).catch(() => {}), 1500);
    return result;
  }, [savePaidInfo, changeStatus, showToast, fetchLeads, leads]);

  const handleDeletePayment = useCallback((id) => {
    deletePayment(id);
    showToast('Payment record removed ✓');
  }, [deletePayment, showToast]);

  const handleSaveCity = useCallback((id, city) => {
    saveCity(id, city);
    // Sync to Clients table
    const lead = leads.find(l => l.id === id);
    if (lead?.phone) syncToClients(lead.phone, { 'City': city }, { city });
  }, [saveCity, leads, syncToClients]);

  const handleSaveJobDate = useCallback((id, jobDate) => {
    saveJobDate(id, jobDate);
  }, [saveJobDate]);

  const handleSaveEmail = useCallback((id, email) => {
    saveEmail(id, email);
    // Sync to Clients table
    const lead = leads.find(l => l.id === id);
    if (lead?.phone) syncToClients(lead.phone, { 'Email': email }, { email });
  }, [saveEmail, leads, syncToClients]);

  const handleRename = useCallback((id, newName) => {
    renameLead(id, newName);
    showToast('Name updated ✓');
    // Sync to Clients table
    const lead = leads.find(l => l.id === id);
    if (lead?.phone) syncToClients(lead.phone, { 'Client Name': newName }, { name: newName });
  }, [renameLead, showToast, leads, syncToClients]);

  const handleSetRefuseReason = useCallback((id, reason) => {
    setRefuseReason(id, reason);
    showToast('Reason updated ✓');
  }, [setRefuseReason, showToast]);

  const handleArchive = useCallback((id) => {
    archiveLead(id);
    closePanel();
    showToast('Lead moved to Deleted History');
  }, [archiveLead, closePanel, showToast]);

  const handlePermanentDelete = useCallback((id) => {
    permanentDelete(id);
    showToast('Lead permanently deleted');
  }, [permanentDelete, showToast]);

  const handleRecoverLead = useCallback((id) => {
    recoverLead(id);
    showToast('Lead recovered ✓');
  }, [recoverLead, showToast]);

  const handleAddLead = useCallback(async (data) => {
    showToast('New lead added ✓');
    const airtableId = await addLead(data);
    if (!airtableId) showToast('Failed to save to Airtable — check connection');
    else upsertClient({ name: data.name, phone: data.phone, email: data.email, address: data.address });
  }, [addLead, showToast, upsertClient]);

  const toggleStatFilter = useCallback((type) => {
    setStatFilter(prev => (prev === type ? null : type));
  }, []);

  // Schedule an appointment from Lead Details:
  // Creates a calBooking (linked to the lead) + sets the lead's jobDate
  const scheduleBooking = useCallback(async (leadId, bookingData) => {
    const localId = await addCalBooking({ ...bookingData, linkedLeadId: leadId });
    if (bookingData.date) {
      saveJobDate(leadId, bookingData.date);
    }
    showToast('Appointment scheduled ✓');
    return localId;
  }, [addCalBooking, saveJobDate, showToast]);

  const activeLead = leads.find(l => l.id === activeId) || null;

  const filteredLeads = useMemo(() => {
    let result = searchTerm
      ? leads.filter(l =>
          l.name.toLowerCase().includes(searchTerm) ||
          l.subject.toLowerCase().includes(searchTerm) ||
          (l.phone || '').toLowerCase().includes(searchTerm)
        )
      : leads;
    if (statFilter === 'calls') {
      result = result.filter(l => l.hasCall);
    } else if (statFilter) {
      result = result.filter(l => l.status === statFilter);
    }
    return result;
  }, [leads, searchTerm, statFilter]);

  return (
    <LeadsContext.Provider value={{
      leads,
      deletedLeads,
      calBookings,
      clients,
      filteredLeads,
      isLoading,
      activeId,
      activeLead,
      searchTerm,
      setSearchTerm,
      currentPage,
      setCurrentPage,
      toast,
      showToast,
      isModalOpen,
      setModalOpen,
      openPanel,
      closePanel,
      statFilter,
      toggleStatFilter,
      sidebarOpen,
      toggleSidebar,
      closeSidebar,
      tutorialOpen,
      startTutorial,
      stopTutorial,
      refuseModalId,
      refuseModalPrevStatus,
      confirmRefuse,
      closeRefuseModal,
      bookModalId,
      confirmBook,
      closeBookModal,
      quoteSendModalId,
      quoteSendLeadName: leads.find(l => l.id === quoteSendModalId)?.name || null,
      confirmQuoteSend,
      closeQuoteSendModal,
      invoiceModalLead: invoiceModalId ? (leads.find(l => l.id === invoiceModalId) || null) : null,
      openInvoiceModal,
      closeInvoiceModal,
      sendInvoice,
      sendQuoteAndChangeStatus,
      quoteTransferModalId,
      quoteTransferTargetStatus,
      quoteTransferLeadValue,
      confirmQuoteTransfer,
      closeQuoteTransferModal,
      changeStatus: handleChangeStatus,
      toggleStar: handleToggleStar,
      saveNote: handleSaveNote,
      saveJobType: handleSaveJobType,
      savePaidInfo: handleSavePaidInfo,
      deletePayment: handleDeletePayment,
      saveCity: handleSaveCity,
      saveJobDate: handleSaveJobDate,
      saveEmail: handleSaveEmail,
      saveQuoteAmount,
      renameLead: handleRename,
      setRefuseReason: handleSetRefuseReason,
      archiveLead: handleArchive,
      permanentDelete: handlePermanentDelete,
      recoverLead: handleRecoverLead,
      addLead: handleAddLead,
      addCalBooking,
      removeCalBooking,
      updateCalBooking,
      recordBookingPayment,
      scheduleBooking,
      upsertClient,
      syncClientsFromLeads,
      updateClient,
      archivedClients,
      archiveClient,
      restoreClient,
      permanentDeleteClient,
      refetch: fetchLeads,
    }}>
      {children}
    </LeadsContext.Provider>
  );
}

export function useLeadsContext() {
  return useContext(LeadsContext);
}
