import { useState, useEffect, useCallback } from 'react';
import { sbSelect } from '../utils/supabaseClient';
import { updateRecord, AT_TABLES } from '../utils/airtableSync';

// RLS already limits these rows to the logged-in technician's own bookings, so a
// plain select returns only their jobs. Cancelled bookings are hidden. Everything
// the tech sees (address, quote, phone…) comes from the booking row itself, since
// the leads/clients tables are RLS-blocked for technicians.
export function useTechnicianBookings() {
  const [myBookings, setMyBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await sbSelect('bookings?select=*&order=date.asc');
      setMyBookings((rows || [])
        .filter(b => b.booking_status !== 'Cancelled')
        .map(b => ({
          id: b.id,
          name: b.client_name || '—',
          phone: b.phone || '',
          city: b.city || '',
          address: b.service_address || '',
          service: b.job_service || '',
          date: b.date ? String(b.date).slice(0, 10) : '',
          time: b.job_time || '',
          quote: Number(b.amount) || 0,
          status: b.booking_status || 'Scheduled',
          notes: b.tech_notes || '',
          completedAt: b.tech_completed_at || null,
        })));
    } catch { /* keep whatever we had; sbSelect throws on auth loss */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Mark done = flip status + stamp completion time so the owner sees
  // "done by tech — needs invoicing". The owner still records payment + invoices.
  const markCompleted = useCallback(async (id) => {
    const at = new Date().toISOString();
    await updateRecord(AT_TABLES.calendar, id, { 'Booking Status': 'Completed', 'Tech Completed At': at });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, status: 'Completed', completedAt: at } : b));
  }, []);

  const reopen = useCallback(async (id) => {
    await updateRecord(AT_TABLES.calendar, id, { 'Booking Status': 'Scheduled', 'Tech Completed At': null });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, status: 'Scheduled', completedAt: null } : b));
  }, []);

  const saveTechNote = useCallback(async (id, note) => {
    await updateRecord(AT_TABLES.calendar, id, { 'Tech Notes': note });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, notes: note } : b));
  }, []);

  return { myBookings, loading, markCompleted, reopen, saveTechNote, refresh };
}
