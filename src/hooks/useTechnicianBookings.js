import { useState, useEffect, useCallback } from 'react';
import { sbSelect } from '../utils/supabaseClient';
import { updateRecord, AT_TABLES } from '../utils/airtableSync';

// RLS already limits these rows to the logged-in technician's own bookings, so a
// plain select returns only their jobs. Cancelled bookings are hidden.
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
          location: b.city || '',
          service: b.job_service || '',
          date: b.date ? String(b.date).slice(0, 10) : '',
          time: b.job_time || '',
          status: b.booking_status || 'Scheduled',
          notes: b.tech_notes || '',
        })));
    } catch { /* keep whatever we had; sbSelect throws on auth loss */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const markCompleted = useCallback(async (id) => {
    await updateRecord(AT_TABLES.calendar, id, { 'Booking Status': 'Completed' });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, status: 'Completed' } : b));
  }, []);

  const saveTechNote = useCallback(async (id, note) => {
    await updateRecord(AT_TABLES.calendar, id, { 'Tech Notes': note });
    setMyBookings(prev => prev.map(b => b.id === id ? { ...b, notes: note } : b));
  }, []);

  return { myBookings, loading, markCompleted, saveTechNote, refresh };
}
