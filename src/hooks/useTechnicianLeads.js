import { useState, useEffect, useCallback } from 'react';
import { sbSelect } from '../utils/supabaseClient';

// Read-only pipeline view for technicians: Quote Sent / Booked / Job Done leads.
// Reads the `tech_leads` DB view, which exposes ONLY safe columns (no money, no
// internal notes) — so amounts never reach the browser. Techs have no write path.
export function useTechnicianLeads() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await sbSelect('tech_leads?select=*');
      setLeads((rows || []).map(r => ({
        id: r.id,
        name: r.client_name || '—',
        phone: r.phone_number || '',
        email: r.email || '',
        status: r.lead_status || '',
        subject: r.inquiry_subject || '',
        service: r.property_type || (Array.isArray(r.services) ? r.services.join(', ') : (r.services || '')),
        details: r.property_details || '',
        windows: r.estimated_window_count || null,
        stories: r.stories || null,
        city: r.city || '',
        address: r.service_address || r.address || '',
        date: (r.scheduled_cleaning_date || r.next_follow_up_date || r.inquiry_date || '').slice(0, 10),
      })));
    } catch { /* view may not exist yet, or auth loss — leave empty */ }
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { leads, loading, refresh };
}
