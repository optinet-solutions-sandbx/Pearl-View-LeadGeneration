import { useState, useMemo } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import { LEAD_SOURCES } from '../utils/constants';
import { overlayClose } from '../utils/overlayClose';

export default function NewLeadModal() {
  const { isModalOpen, setModalOpen, addLead, clients, leads } = useLeadsContext();

  const [form, setForm] = useState({
    leadSource: 'Other',
    name: '',
    phone: '',
    email: '',
    address: '',
    subject: '',
    value: '',
  });
  const [showSuggestions, setShowSuggestions] = useState(false);

  function handleChange(e) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  // Autocomplete suggestions from clients + leads
  const suggestions = useMemo(() => {
    if (form.name.trim().length < 1) return [];
    const term = form.name.toLowerCase();
    const seen = new Set();
    const result = [];

    (clients || []).forEach(c => {
      if (!c.name?.toLowerCase().includes(term)) return;
      const key = (c.phone || c.name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ id: c.id, name: c.name, phone: c.phone, email: c.email, address: c.address, city: c.city, fromClients: true });
    });

    (leads || []).forEach(l => {
      if (!l.name?.toLowerCase().includes(term)) return;
      const key = (l.phone || l.name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      result.push({ id: l.id, name: l.name, phone: l.phone, email: l.email, address: l.address, city: l.city, fromClients: false });
    });

    return result.slice(0, 8);
  }, [form.name, clients, leads]);

  function selectSuggestion(item) {
    setForm(prev => ({
      ...prev,
      name:    item.name    || prev.name,
      phone:   item.phone   || prev.phone,
      email:   item.email   || prev.email,
      address: item.address || prev.address,
    }));
    setShowSuggestions(false);
  }

  function handleSave() {
    if (!form.name.trim()) {
      alert('Name is required.');
      return;
    }
    addLead({
      source: 'manual',
      leadSource: form.leadSource,
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      address: form.address.trim(),
      subject: form.subject.trim(),
      value: parseInt(form.value) || 0,
    });
    setForm({ leadSource: 'Other', name: '', phone: '', email: '', address: '', subject: '', value: '' });
    setModalOpen(false);
  }

  if (!isModalOpen) return null;

  return (
    <div className="overlay open" {...overlayClose(() => setModalOpen(false))}>
      <div className="modal">
        <div className="modal-title">+ Add New Lead</div>

        <div className="fgroup">
          <label className="flabel">Lead Source</label>
          <select className="fselect" name="leadSource" value={form.leadSource} onChange={handleChange}>
            {LEAD_SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        {/* Name with autocomplete */}
        <div className="fgroup" style={{ position: 'relative' }}>
          <label className="flabel">Full Name</label>
          <input
            className="finput"
            name="name"
            placeholder="e.g. John Smith"
            value={form.name}
            onChange={e => { handleChange(e); setShowSuggestions(true); }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
            autoComplete="off"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
              background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.12)', marginTop: '2px', overflow: 'hidden',
            }}>
              {suggestions.map(item => (
                <div
                  key={item.id}
                  onMouseDown={() => selectSuggestion(item)}
                  style={{
                    padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--gray-100)',
                    display: 'flex', alignItems: 'center', gap: '8px',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--gray-50)'}
                  onMouseLeave={e => e.currentTarget.style.background = ''}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>{item.name}</span>
                    <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '1px' }}>
                      {[item.phone, item.city].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {item.fromClients && (
                    <span style={{ fontSize: '9px', fontWeight: 700, background: '#eff6ff', color: 'var(--primary)', padding: '1px 5px', borderRadius: '6px', flexShrink: 0 }}>CLIENT</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="fgroup">
          <label className="flabel">Phone</label>
          <input className="finput" name="phone" placeholder="(555) 000-0000" value={form.phone} onChange={handleChange} />
        </div>
        <div className="fgroup">
          <label className="flabel">Email</label>
          <input className="finput" name="email" placeholder="email@example.com" value={form.email} onChange={handleChange} />
        </div>
        <div className="fgroup">
          <label className="flabel">Address</label>
          <input className="finput" name="address" placeholder="e.g. 123 Main St, Brisbane" value={form.address} onChange={handleChange} />
        </div>
        <div className="fgroup">
          <label className="flabel">Subject / Reason</label>
          <textarea className="ftextarea" name="subject" placeholder="e.g. Quotation for 3-story commercial building…" value={form.subject} onChange={handleChange} />
        </div>
        <div className="fgroup">
          <label className="flabel">Estimated Value ($)</label>
          <input className="finput" name="value" type="number" placeholder="0" value={form.value} onChange={handleChange} />
        </div>

        <div className="modal-footer">
          <button className="btn-cancel" onClick={() => setModalOpen(false)}>Cancel</button>
          <button className="btn-save-modal" onClick={handleSave}>Save Lead</button>
        </div>
      </div>
    </div>
  );
}
