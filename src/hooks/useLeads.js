import { useState, useCallback, useRef } from 'react';
import { STATUS_MAP, AT_STATUS_MAP, PROG_MAP } from '../utils/constants';
import { parseDate } from '../utils/dateUtils';
import { createRecord, updateRecord, deleteRecord, fetchRecords, AT_TABLES } from '../utils/airtableSync';

const VALID_JOB_TYPES = new Set(['Window Cleaning', 'Pressure Washing', 'Solar Panel', 'Other']);

const IS_LOCAL = import.meta.env.DEV;
const AT_TOKEN = import.meta.env.VITE_AIRTABLE_TOKEN || '';
const AT_BASE  = import.meta.env.VITE_AIRTABLE_BASE_ID || '';
const AT_TABLE = import.meta.env.VITE_AIRTABLE_TABLE_ID || '';

// ── Mobile Message broadcast list sync (non-blocking) ──────────────────────
// Every new lead/client phone is added to MM list MM_LIST_ID so the owner can
// blast monthly SMS broadcasts from mobilemessage.com.au without manual entry.
// In local dev we call MM directly; in prod we go through /api/mm-sync-contact
// (keeps the API password off the client bundle on the live site).
const MM_USER  = import.meta.env.VITE_MM_USERNAME      || '';
const MM_PASS  = import.meta.env.VITE_MM_API_PASSWORD  || '';
const MM_LIST  = import.meta.env.VITE_MM_LIST_ID       || '';

function normaliseAuPhone(input) {
  if (!input) return '';
  let s = String(input).replace(/[^\d+]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('0')) s = '61' + s.slice(1);
  if (s.length === 9 && s.startsWith('4')) s = '61' + s;
  return s;
}

async function syncToMobileMessage({ name, phone, email, inquiryDate }) {
  const num = normaliseAuPhone(phone);
  if (!num || num.length < 10) return;
  const [first = '', ...rest] = String(name || '').trim().split(/\s+/);
  const last = rest.join(' ');
  // YYYY-MM-DD sorts lexicographically in MM's custom field column.
  const ymd = (() => {
    const d = inquiryDate ? new Date(inquiryDate) : new Date();
    return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  })();

  if (IS_LOCAL) {
    if (!MM_USER || !MM_PASS || !MM_LIST) return;
    const auth = btoa(`${MM_USER}:${MM_PASS}`);
    const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' };
    try {
      // Check if contact already exists — if so, leave name/date alone.
      const lookup = await fetch(
        `/mm-api/v1/contacts?number=${encodeURIComponent(num)}&limit=1`,
        { headers: { Authorization: `Basic ${auth}` } }
      ).then(r => r.json()).catch(() => null);
      const existing = lookup?.results?.length > 0;
      if (!existing) {
        const contactBody = { number: num };
        if (first) contactBody.first_name = first;
        if (last)  contactBody.last_name  = last;
        if (email) contactBody.other      = email;
        if (ymd)   contactBody.field_1    = ymd;
        await fetch('/mm-api/v1/contacts', {
          method: 'POST', headers, body: JSON.stringify(contactBody),
        }).catch(() => {});
      }
      await fetch('/mm-api/v1/list-contacts', {
        method: 'POST', headers,
        body: JSON.stringify({ list_id: Number(MM_LIST), number: num }),
      })
        .then(r => r.json().then(d => console.log('MM sync:', { existed: existing, ...d })).catch(() => {}));
    } catch (err) {
      console.error('MM sync failed:', err);
    }
  } else {
    fetch('/api/mm-sync-contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: num, firstName: first, lastName: last, email: email || '', inquiryDate: ymd }),
    })
      .then(r => r.json().then(d => console.log('MM sync:', d)).catch(() => {}))
      .catch(err => console.error('MM sync failed:', err));
  }
}

function normaliseRecord(rec) {
  const f = rec.fields;
  const isCall = !!(f['Caller ID'] || f['Call Time']);
  const rawSrc = isCall ? (f['Call - Lead Source'] || '') : (f['Lead Source'] || '');
  const rawSrcNorm = rawSrc.toLowerCase().replace(/[\s-]/g, '');

  // LP only set for website leads; all other sources (Phone Call, Facebook, Google, Other) get null
  let lp = null;
  if (rawSrcNorm.includes('pearlview')) lp = 'LP2';
  else if (rawSrcNorm.includes('crystalpro') || rawSrcNorm.includes('crystal')) lp = 'LP1';

  // source encodes call vs form type (used for isCallLead detection)
  let source;
  if (isCall) {
    source = lp === 'LP2' ? 'call2' : 'call1';
  } else {
    source = lp === 'LP2' ? 'form2' : 'form1';
  }
  const rawStatus = f['Lead Status'] || 'New';
  const status = STATUS_MAP[rawStatus] || 'new';
  const name = f['Client Name'] || (isCall ? 'Unknown Caller' : 'Unknown');
  const fullSubject = isCall ? (f['Call Recording Transcript'] || '') : (f['Inquiry Subject/Reason'] || '');
  const rawDate = isCall ? f['Call Time'] : f['Inquiry Date'];
  return {
    id: rec.id, name, source,
    lp,
    phone: f['Phone Number'] || f['Caller ID'] || '',
    email: f['Email'] || '',
    subject: fullSubject,
    date: rawDate || '',
    dateObj: parseDate(rawDate),
    address: f['Adress'] || f['Service Address'] || '',
    jobType: VALID_JOB_TYPES.has(f['Property Type']) ? f['Property Type'] : '',
    windows: f['Estimated Window Count'] || 0,
    stories: f['Stories'] || 0,
    value: f['Quote Amount'] || 0,
    invoice: f['Final Invoice Amount'] || 0,
    duration: f['Call Duration'] || '',
    followUp: f['Next Follow-up Date'] || '',
    jobDate: f['Scheduled Cleaning Date'] || '',
    details: f['Property Details'] || '',
    status, progress: PROG_MAP[status] || 10,
    starred: false, notes: f['Notes'] || '', hasCall: isCall, tag: '',
    refuseReason: f['Refusal Reason'] || '',
    paidAmount: parseFloat(f['Amount Paid'] || 0),
    paid: !!(f['Paid'] || parseFloat(f['Amount Paid'] || 0) > 0),
    paymentMethod: f['Payment Method'] || '',
    city: f['City'] || '',
    leadChannel: f['Lead Channel'] || '',
    leadSource: f['Lead Source'] || '',
    invoiceNumber: f['Invoice Number'] || null,
    invoiceSent: !!f['Invoice Sent'],
    airtableId: rec.id,
  };
}

// ─── Normalise a raw Airtable Bookings record into the calBooking shape ───────
function normaliseCalBooking(rec) {
  const f = rec.fields;
  // Source encoded in Booking Name: "LEAD::Name - date" = from lead flow, else manual
  const bookingName   = f['Booking Name'] || '';
  const isLeadBooking = bookingName.startsWith('LEAD::');
  return {
    id:             `cal-${rec.id}`,
    airtableId:     rec.id,
    clientName:     f['Client Name']     || '',
    phone:          f['Phone']           || '',
    email:          '',
    city:           f['City']            || '',
    service:        f['Job_Service']     || '',
    paymentMethod:  'Cash',
    date:           f['Date']            ? f['Date'].split('T')[0] : '',
    bookingStatus:  f['Booking Status']  || 'Scheduled',
    amount:         f['Amount']          || 0,
    jobTime:        f['Job Time']        || '',
    assignedWorker: f['Assigned Worker'] || '',
    upsellAmount:   f['Upsell Amount']   || 0,
    upsellNotes:    f['Upsell Notes']    || '',
    linkedLeadId:   null,
    bookingSource:  isLeadBooking ? 'Lead' : 'Manual',
  };
}

// ─── Refusal reason → Refused table singleSelect label ───────────────────────
const REFUSED_REASON_MAP = {
  too_expensive: '💰 Too Expensive',
  competition:   '🏆 Went with Competition',
  no_answer:     '📵 No Answer / Ghosted',
  other:         '❓ Other',
};

// ─── Write a Revenue record when payment is recorded ─────────────────────────
// status: 'Job Done' counts as income in Reports; anything else is In Progress
function writeRevenue(lead, paidAmount, paymentMethod, status) {
  if (!paidAmount || paidAmount <= 0) return Promise.resolve(null);
  return createRecord(AT_TABLES.revenue, {
    'Revenue Name':   `${lead.name} - ${lead.jobType || 'Window Cleaning'}`,
    'Date':           new Date().toISOString().split('T')[0],
    'Client Name':    lead.name,
    'Phone':          lead.phone || '',
    'Job_Service':    lead.jobType || 'Window Cleaning',
    'City':           lead.city || '',
    'Payment_Method': paymentMethod || 'Cash',
    'Amount':         paidAmount,
    'Status':         status || 'In Progress',
  });
}

// ─── Normalise a raw Airtable Clients record ──────────────────────────────────
function normaliseClient(rec) {
  const f = rec.fields;
  return {
    id:         rec.id,
    airtableId: rec.id,
    name:       f['Client Name']   || f['Name'] || '',
    phone:      f['Phone']         || f['Phone Number'] || '',
    email:      f['Email']         || '',
    address:    f['Address']       || f['Service Address'] || f['Adress'] || '',
    city:       f['City']          || '',
    notes:      f['Notes']         || '',
    jobType:    f['Property Type'] || '',
    leadSource: f['Lead Source']   || '',
    status:     f['Status']        || '',
  };
}

export function useLeads() {
  const [leads,        setLeads]        = useState([]);
  const [deletedLeads, setDeletedLeads] = useState([]);
  const [calBookings,  setCalBookings]  = useState([]);
  const [clients,         setClients]         = useState([]);
  const [archivedClients, setArchivedClients] = useState([]);
  const [isLoading,    setIsLoading]    = useState(true);
  // Track in-flight Airtable writes so silent polls don't overwrite optimistic UI
  const pendingWrites = useRef(0);
  // IDs permanently deleted locally — filtered from fetchLeads until Airtable confirms deletion
  const permanentlyDeletedIds = useRef(new Set());
  // Epoch increments on every write — lets fetchLeads detect if a write started mid-fetch
  const writeEpoch = useRef(0);

  // ─── Awaitable Airtable PATCH — tracks in-flight count ───────────────────────
  const patchAirtable = useCallback((airtableId, fields) => {
    if (!airtableId) { console.warn('patchAirtable: no airtableId, skipping'); return Promise.resolve(null); }
    const logFields = Object.keys(fields).join(', ');
    writeEpoch.current++;   // signal that a write is starting
    pendingWrites.current++;
    const req = IS_LOCAL
      ? fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}/${airtableId}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields, typecast: true }),
        })
      : fetch('/api/update-lead', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ airtableId, fields, typecast: true }),
        });
    return req
      .then(r => {
        if (!r.ok) return r.json().then(e => {
          const msg = e?.error?.message || e?.message || e?.error || `HTTP ${r.status}`;
          console.error('Airtable patch failed:', logFields, e);
          return { __patchFailed: true, error: msg };
        });
        console.log('Airtable synced:', logFields);
        return r.json();
      })
      .catch(err => { console.error('Airtable sync error:', err); return { __patchFailed: true, error: err.message }; })
      .finally(() => { pendingWrites.current--; });
  }, []);

  const fetchLeads = useCallback(async ({ silent = false } = {}) => {
    // Don't overwrite optimistic UI while writes are in-flight
    if (silent && pendingWrites.current > 0) {
      console.log('Skipping silent poll — writes in-flight');
      return;
    }
    // Capture epoch before fetching — if a write starts mid-fetch, we'll skip setLeads
    const epochAtStart = writeEpoch.current;
    if (!silent) setIsLoading(true);
    try {
      // ── Fetch leads ──────────────────────────────────────────────────────────
      let allRecords = [];
      if (IS_LOCAL) {
        let offset = '';
        do {
          const url = `https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}?pageSize=100${offset ? '&offset=' + encodeURIComponent(offset) : ''}`;
          const res = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
          if (!res.ok) throw new Error(`Airtable error: ${res.status}`);
          const data = await res.json();
          allRecords.push(...(data.records || []));
          offset = data.offset || '';
        } while (offset);
      } else {
        const res = await fetch('/api/leads');
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `API error: ${res.status}`);
        allRecords = data.records;
      }
      // ── Fetch revenue in parallel ─────────────────────────────────────────────
      const revenueRecs = await fetchRecords(AT_TABLES.revenue);
      // Build payment lookups (highest amount wins). Match by phone when the
      // Revenue record has one; otherwise fall back to Client Name so payments
      // on phone-less leads still re-link to their lead on reload.
      const paymentByPhone = {};
      const paymentByName  = {};
      revenueRecs.forEach(r => {
        const phone  = (r.fields?.['Phone'] || '').replace(/\s/g, '').toLowerCase();
        const name   = (r.fields?.['Client Name'] || '').trim().toLowerCase();
        const amount = parseFloat(r.fields?.['Amount'] || 0);
        if (amount <= 0) return;
        const entry = {
          paid: true,
          paidAmount: amount,
          paymentMethod: r.fields?.['Payment_Method'] || '',
          revenueRecordId: r.id,
        };
        if (phone) {
          const ex = paymentByPhone[phone];
          if (!ex || amount > ex.paidAmount) paymentByPhone[phone] = entry;
        } else if (name) {
          const ex = paymentByName[name];
          if (!ex || amount > ex.paidAmount) paymentByName[name] = entry;
        }
      });

      const all = allRecords.map(r => {
        const lead = normaliseRecord(r);
        const phoneKey = (lead.phone || '').replace(/\s/g, '').toLowerCase();
        const nameKey  = (lead.name  || '').trim().toLowerCase();
        const payment = (phoneKey && paymentByPhone[phoneKey])
          || (nameKey && paymentByName[nameKey])
          || {};
        return { ...lead, ...payment };
      });
      const active  = all.filter(r => r.status !== 'archived').sort((a, b) => b.dateObj - a.dateObj);
      const archived = all
        .filter(r => r.status === 'archived' && !permanentlyDeletedIds.current.has(r.airtableId))
        .sort((a, b) => b.dateObj - a.dateObj)
        .map(r => ({ ...r, deletedAt: r.dateObj }));
      // Skip if a write started while we were fetching — our data is now stale
      if (silent && epochAtStart !== writeEpoch.current) {
        console.log('Skipping setLeads — write happened mid-fetch');
        return;
      }
      setLeads(active);
      setDeletedLeads(archived);

      // ── Fetch cal bookings (in parallel, non-blocking) ───────────────────────
      fetchRecords(AT_TABLES.calendar).then(recs => {
        setCalBookings(recs.map(r => normaliseCalBooking(r)));
      });

      // ── Fetch clients (in parallel, non-blocking) ─────────────────────────────
      fetchRecords(AT_TABLES.clients).then(recs => {
        const all = recs.map(r => normaliseClient(r));
        setClients(all.filter(c => c.status !== 'Archived'));
        setArchivedClients(all.filter(c => c.status === 'Archived'));
      });
    } catch (err) {
      console.error('Failed to load from Airtable:', err);
      throw err;
    } finally {
      if (!silent) setIsLoading(false);
    }
  }, [patchAirtable]);

  // ─── Awaits the PATCH — confirms status from Airtable response without overwriting
  //     other fields that may have their own in-flight PATCHes (e.g. Quote Amount)
  //
  // NOTE: reads `leads` directly (not via setLeads extraction) because React 18
  // automatic batching does not execute setLeads callbacks synchronously when called
  // in async continuations (after await). Adding `leads` to deps ensures we always
  // have the current snapshot.
  const changeStatus = useCallback(async (id, status, extraFields = {}) => {
    const currentLead = leads.find(l => l.id === id);
    if (!currentLead?.airtableId) return 'Status updated';
    const prevLead = currentLead;
    // Optimistic update
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      const extra = {};
      if (extraFields['Quote Amount'] !== undefined) extra.value = extraFields['Quote Amount'];
      return { ...l, status, progress: PROG_MAP[status] || 10, ...extra };
    }));
    const atFields = { 'Lead Status': AT_STATUS_MAP[status] || status, ...extraFields };
    const result = await patchAirtable(currentLead.airtableId, atFields);
    const patchFailed = !result || result.__patchFailed;
    if (patchFailed) {
      setLeads(prev => prev.map(l => l.id === id ? prevLead : l));
      return 'error';
    }
    // Confirm status/progress from Airtable response only — don't overwrite other fields
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      const confirmed = normaliseRecord(result);
      const confirmedStatus   = confirmed?.status   ?? status;
      const confirmedProgress = confirmed?.progress ?? (PROG_MAP[status] || 10);
      return { ...l, status: confirmedStatus, progress: confirmedProgress };
    }));
    // Scenario 3 → Scenario 1: lead had payment but wasn't job_done yet — update Revenue
    if (status === 'job_done' && currentLead?.paid && currentLead?.paidAmount > 0) {
      fetchRecords(AT_TABLES.revenue).then(revRecs => {
        const phone = (currentLead.phone || '').replace(/\s/g, '').toLowerCase();
        const match = revRecs.find(r => {
          const rPhone = (r.fields?.['Phone'] || '').replace(/\s/g, '').toLowerCase();
          return rPhone === phone && parseFloat(r.fields?.['Amount'] || 0) > 0;
        });
        if (match) updateRecord(AT_TABLES.revenue, match.id, { 'Status': 'Job Done' });
      });
    }
    // Mark linked calBooking as Completed when lead is set to Job Done
    if (status === 'job_done') {
      const phone = (currentLead.phone || '').replace(/\s/g, '').toLowerCase();
      setCalBookings(prev => {
        const linked = prev.find(b =>
          b.id === currentLead.id ||
          (b.linkedLeadId && b.linkedLeadId === id) ||
          (phone && (b.phone || '').replace(/\s/g, '').toLowerCase() === phone)
        );
        if (!linked || linked.bookingStatus === 'Completed') return prev;
        if (linked.airtableId) {
          updateRecord(AT_TABLES.calendar, linked.airtableId, { 'Booking Status': 'Completed' });
        }
        return prev.map(b => b.id === linked.id ? { ...b, bookingStatus: 'Completed' } : b);
      });
    }
    return 'ok';
  }, [patchAirtable, leads]);

  const toggleStar = useCallback((id) => {
    setLeads(prev => prev.map(l => l.id === id ? { ...l, starred: !l.starred } : l));
  }, []);

  const saveNote = useCallback((id, note) => {
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (l.airtableId) patchAirtable(l.airtableId, { 'Notes': note });
      return { ...l, notes: note };
    }));
  }, [patchAirtable]);

  const renameLead = useCallback((id, newName) => {
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (l.airtableId) patchAirtable(l.airtableId, { 'Client Name': newName });
      return { ...l, name: newName };
    }));
  }, [patchAirtable]);

  const setRefuseReason = useCallback((id, reason) => {
    let airtableId = null;
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      airtableId = l.airtableId;
      return { ...l, refuseReason: reason };
    }));
    const mapped = REFUSED_REASON_MAP[reason] || reason;
    return airtableId ? patchAirtable(airtableId, { 'Refusal Reason': mapped }) : Promise.resolve(null);
  }, [patchAirtable]);

  // ─── Save payment info ─────────────────────────────────────────────────────────
  // Revenue logic:
  //   S1 job_done + paid now  → Revenue Status='Job Done'  (counts as income)
  //   S3 paid + not job_done  → Revenue Status='In Progress' (persists payment, not income yet)
  //      When job later marked done → changeStatus updates Revenue Status to 'Job Done'
  // Returns { success, wasJobDone } so context can auto-advance status for S3.
  const savePaidInfo = useCallback(async (id, paid, paidAmount, paymentMethod) => {
    let leadSnapshot = null;
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      leadSnapshot = l;
      return { ...l, paid, paidAmount, paymentMethod };
    }));
    const updatedLead = leadSnapshot ? { ...leadSnapshot, paid, paidAmount, paymentMethod } : null;
    const wasJobDone = leadSnapshot?.status === 'job_done';
    // Write Revenue with appropriate status — 'Job Done' only when job is already done
    if (paid && paidAmount > 0 && !leadSnapshot?.paid) {
      const revStatus = wasJobDone ? 'Job Done' : 'In Progress';
      await writeRevenue(updatedLead, paidAmount, paymentMethod, revStatus);
    }
    // Update linked calendar booking if one exists (match by phone)
    if (paid && paidAmount > 0 && updatedLead?.phone) {
      setCalBookings(prev => {
        const linked = prev.find(b => b.linkedLeadId === id || (b.phone && updatedLead.phone && b.phone === updatedLead.phone));
        if (linked?.airtableId) {
          updateRecord(AT_TABLES.calendar, linked.airtableId, {
            'Booking Status': 'Completed',
            'Amount': paidAmount,
          });
          return prev.map(b => b.id === linked.id ? { ...b, bookingStatus: 'Completed', amount: paidAmount } : b);
        }
        return prev;
      });
    }
    return { success: true, wasJobDone };
  }, []);

  const saveCity = useCallback((id, city) => {
    // City field doesn't exist in Leads table — in-memory only
    setLeads(prev => prev.map(l => l.id === id ? { ...l, city } : l));
  }, []);

  const saveJobType = useCallback((id, jobType) => {
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (l.airtableId) patchAirtable(l.airtableId, { 'Property Type': jobType });
      return { ...l, jobType };
    }));
  }, [patchAirtable]);

  const saveJobDate = useCallback((id, jobDate) => {
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      // Airtable requires null (not '') to clear a date field
      if (l.airtableId) patchAirtable(l.airtableId, { 'Scheduled Cleaning Date': jobDate || null });
      return { ...l, jobDate };
    }));
  }, [patchAirtable]);

  const saveEmail = useCallback((id, email) => {
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      if (l.airtableId) patchAirtable(l.airtableId, { 'Email': email });
      return { ...l, email };
    }));
  }, [patchAirtable]);

  const saveQuoteAmount = useCallback((id, amount) => {
    let airtableId = null;
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      airtableId = l.airtableId;
      return { ...l, value: amount };
    }));
    return airtableId ? patchAirtable(airtableId, { 'Quote Amount': amount }) : Promise.resolve(null);
  }, [patchAirtable]);

  const clearQuoteAmount = useCallback((id) => {
    let airtableId = null;
    setLeads(prev => prev.map(l => {
      if (l.id !== id) return l;
      airtableId = l.airtableId;
      return { ...l, value: 0 };
    }));
    return airtableId ? patchAirtable(airtableId, { 'Quote Amount': 0 }) : Promise.resolve(null);
  }, [patchAirtable]);

  // ─── Delete payment: remove Revenue record from Airtable + clear local state ──
  const deletePayment = useCallback((id) => {
    setLeads(prev => {
      const lead = prev.find(l => l.id === id);
      if (!lead) return prev;
      if (lead.revenueRecordId) {
        deleteRecord(AT_TABLES.revenue, lead.revenueRecordId);
      } else if (lead.phone) {
        const phone = (lead.phone || '').replace(/\s/g, '').toLowerCase();
        fetchRecords(AT_TABLES.revenue).then(recs => {
          const match = recs.find(r =>
            (r.fields?.['Phone'] || '').replace(/\s/g, '').toLowerCase() === phone
          );
          if (match) deleteRecord(AT_TABLES.revenue, match.id);
        });
      }
      return prev.map(l => l.id === id
        ? { ...l, paid: false, paidAmount: 0, paymentMethod: '', revenueRecordId: null }
        : l
      );
    });
  }, []);

  // Move lead to deleted history (soft delete) + sync to Airtable
  const archiveLead = useCallback((id) => {
    setLeads(prev => {
      const lead = prev.find(l => l.id === id);
      if (lead) {
        if (lead.airtableId) patchAirtable(lead.airtableId, { 'Lead Status': 'Archived' });
        setDeletedLeads(d => [{ ...lead, deletedAt: new Date() }, ...d]);
      }
      return prev.filter(l => l.id !== id);
    });
  }, [patchAirtable]);

  // Permanently remove from deleted history + delete from Airtable
  const permanentDelete = useCallback((id) => {
    setDeletedLeads(prev => {
      const lead = prev.find(l => l.id === id);
      if (lead?.airtableId) {
        // Register ID immediately so fetchLeads polls don't bring it back before delete completes
        permanentlyDeletedIds.current.add(lead.airtableId);
        // Use AT_TABLES.leads (has fallback name) instead of AT_TABLE which may be '' in production
        deleteRecord(AT_TABLES.leads, lead.airtableId);
      }
      return prev.filter(l => l.id !== id);
    });
  }, []);

  // Move back from deleted history to active leads + restore Airtable status
  const recoverLead = useCallback((id) => {
    setDeletedLeads(prev => {
      const lead = prev.find(l => l.id === id);
      if (lead) {
        if (lead.airtableId) patchAirtable(lead.airtableId, { 'Lead Status': 'New Lead' });
        const { deletedAt: _d, ...restored } = lead;
        const recoveredLead = { ...restored, status: 'new', progress: 10 };
        setLeads(ls => [recoveredLead, ...ls].sort((a, b) => b.dateObj - a.dateObj));
      }
      return prev.filter(l => l.id !== id);
    });
  }, [patchAirtable]);

  const addLead = useCallback(async (leadData) => {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      + ' ' + now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const tempId = String(Date.now());
    // Derive lp from leadSource (same logic as normaliseRecord) so badge is correct immediately
    const srcNorm = (leadData.leadSource || '').toLowerCase().replace(/\s/g, '');
    const derivedLp = srcNorm.includes('pearlview') ? 'LP2'
      : (srcNorm.includes('crystalpro') || srcNorm.includes('crystal')) ? 'LP1'
      : null;
    setLeads(prev => [{
      id: tempId, ...leadData,
      lp: derivedLp,
      status: 'new', date: dateStr, dateObj: now,
      address: leadData.address || '', jobType: 'Residential', windows: 0,
      starred: false, notes: '', hasCall: leadData.source?.startsWith('call') || false,
      progress: 10, refuseReason: '', airtableId: null,
      leadSource: leadData.leadSource || '',
    }, ...prev]);
    // Create record in Airtable — use dedicated endpoint (mirrors patchAirtable pattern)
    const fields = {
      'Client Name':             leadData.name,
      'Phone Number':            leadData.phone      || '',
      'Email':                   leadData.email      || '',
      'Inquiry Subject/Reason':  leadData.subject    || '',
      'Lead Status':             'New Lead',
      'Quote Amount':            leadData.value      || 0,
      'Inquiry Date':            now.toISOString(),
      'Lead Source':             leadData.leadSource || '',
    };
    const req = IS_LOCAL
      ? fetch(`https://api.airtable.com/v0/${AT_BASE}/${AT_TABLE}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields, typecast: true }),
        })
      : fetch('/api/create-lead', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields }),
        });
    try {
      const r = await req;
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        console.error('addLead: Airtable rejected the record:', err);
        return null;
      }
      const data = await r.json();
      if (data.id) {
        setLeads(prev => prev.map(l => l.id === tempId ? { ...l, airtableId: data.id } : l));
        // Notify WhatsApp service
        const webhookUrl = import.meta.env.VITE_WEBHOOK_URL;
        if (webhookUrl) {
          fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name:       leadData.name        || '',
              phone:      leadData.phone       || '',
              email:      leadData.email       || '',
              subject:    leadData.subject     || '',
              leadSource: leadData.leadSource  || '',
            }),
          })
            .then(r => r.json().then(d => console.log('WhatsApp notification:', d)))
            .catch(err => console.error('WhatsApp notification failed:', err));
        } else {
          console.warn('VITE_WEBHOOK_URL not set — skipping WhatsApp notification');
        }
        // Sync phone number to Mobile Message broadcast list (non-blocking)
        syncToMobileMessage({
          name:  leadData.name  || '',
          phone: leadData.phone || '',
          email: leadData.email || '',
          inquiryDate: now.toISOString(),
        });
        return data.id;
      }
      return null;
    } catch (err) {
      console.error('addLead: failed to create in Airtable', err);
      return null;
    }
  }, []);

  // ─── Sync a lead's field update to the matching Clients table record ─────────
  // phone: the lead's phone number (used for matching)
  // atFields: Airtable field names + values to patch (e.g. { 'Client Name': 'John' })
  // localFields: local client object keys to update (e.g. { name: 'John' })
  const syncToClients = useCallback((phone, atFields, localFields = {}) => {
    if (!phone) return;
    const normalPhone = (phone || '').replace(/\s/g, '').toLowerCase();
    const client = clients.find(c => (c.phone || '').replace(/\s/g, '').toLowerCase() === normalPhone);
    if (client?.airtableId) {
      updateRecord(AT_TABLES.clients, client.airtableId, atFields);
      if (Object.keys(localFields).length) {
        setClients(prev => prev.map(c => c.airtableId === client.airtableId ? { ...c, ...localFields } : c));
      }
    }
  }, [clients]);

  // ─── Create a new client record in the Clients table ─────────────────────────
  const upsertClient = useCallback(async (lead) => {
    if (!lead?.name) return;
    const normalPhone = (lead.phone || '').replace(/\s/g, '').toLowerCase();
    // Deduplicate: by phone (if provided), otherwise by exact name match
    const exists = normalPhone
      ? clients.find(c => (c.phone || '').replace(/\s/g, '').toLowerCase() === normalPhone)
      : clients.find(c => (c.name || '').toLowerCase().trim() === (lead.name || '').toLowerCase().trim());
    if (exists) return; // already in Clients table
    // Use exact Airtable Clients table field names: 'Phone Number' and 'Adress' (sic)
    const src = lead.leadSource || (lead.lp === 'LP2' ? 'website-pearlview' : lead.lp === 'LP1' ? 'website-crystalpro' : '');
    const newId = await createRecord(AT_TABLES.clients, {
      'Client Name':   lead.name,
      'Phone Number':  lead.phone   || '',
      'Email':         lead.email   || '',
      'Adress':        lead.address || '',
      'City':          lead.city    || '',
      'Notes':         lead.notes   || '',
      'Property Type': lead.jobType || '',
      'Lead Source':   src,
    });
    if (newId) {
      setClients(prev => [...prev, {
        id: newId, airtableId: newId,
        name: lead.name, phone: lead.phone || '',
        email: lead.email || '', address: lead.address || '',
        city: lead.city || '', notes: lead.notes || '', jobType: lead.jobType || '',
        leadSource: src, status: '',
      }]);
      // Sync phone to Mobile Message broadcast list (non-blocking)
      syncToMobileMessage({
        name:  lead.name  || '',
        phone: lead.phone || '',
        email: lead.email || '',
        inquiryDate: lead.dateObj || lead.date || new Date(),
      });
    }
  }, [clients]);

  // ─── Populate Clients table from leads ───────────────────────────────────────
  // - Creates new Clients records for leads not already in the table
  // - Updates Lead Source for existing clients that have it blank
  // Returns count of records created or updated.
  const syncClientsFromLeads = useCallback(async () => {
    // Build a phone → client map for quick lookup
    const phoneToClient = {};
    const nameToClient  = {};
    clients.forEach(c => {
      const p = (c.phone || '').replace(/\s/g, '').toLowerCase();
      if (p) phoneToClient[p] = c;
      else   nameToClient[(c.name || '').toLowerCase().trim()] = c;
    });

    const toCreate = [];
    const toUpdate = []; // existing clients missing Lead Source
    const batchPhones = new Set();
    const batchNames  = new Set();

    leads.forEach(l => {
      const rawName = (l.name || '').trim();
      const displayName = (rawName && rawName !== 'Unknown' && rawName !== 'Unknown Caller')
        ? rawName : (l.phone || null);
      if (!displayName) return;

      const phone = (l.phone || '').replace(/\s/g, '').toLowerCase();
      const lname = displayName.toLowerCase();
      // Use actual lead source (e.g. 'website-pearlview', 'Phone Call', 'Facebook')
      // Fall back to LP-derived label only if leadSource is empty
      const lpSrc = l.leadSource || (l.lp === 'LP2' ? 'website-pearlview' : 'website-crystalpro');

      // Check if already exists
      const existing = phone ? phoneToClient[phone] : nameToClient[lname];
      if (existing) {
        // Update Lead Source if blank
        if (!existing.leadSource && existing.airtableId) {
          toUpdate.push({ client: existing, lpSrc });
        }
        return;
      }

      // Not in Clients table — queue for creation (dedup within batch)
      if (phone) {
        if (batchPhones.has(phone)) return;
        batchPhones.add(phone);
      } else {
        if (batchNames.has(lname)) return;
        batchNames.add(lname);
      }
      toCreate.push({ ...l, name: displayName, lpSrc });
    });

    let count = 0;

    // Update existing clients missing Lead Source
    for (const { client, lpSrc } of toUpdate) {
      updateRecord(AT_TABLES.clients, client.airtableId, { 'Lead Source': lpSrc });
      setClients(prev => prev.map(c =>
        c.airtableId === client.airtableId ? { ...c, leadSource: lpSrc } : c
      ));
      count++;
      await new Promise(r => setTimeout(r, 220));
    }

    // Create new client records
    const newClients = [];
    for (const l of toCreate) {
      const id = await createRecord(AT_TABLES.clients, {
        'Client Name':   l.name,
        'Phone Number':  l.phone   || '',
        'Email':         l.email   || '',
        'Adress':        l.address || '',
        'City':          l.city    || '',
        'Notes':         l.notes   || '',
        'Property Type': l.jobType || '',
        'Lead Source':   l.lpSrc,
      });
      if (id) {
        newClients.push({
          id, airtableId: id,
          name: l.name, phone: l.phone || '',
          email: l.email || '', address: l.address || '',
          city: l.city || '', notes: l.notes || '', jobType: l.jobType || '',
          leadSource: l.lpSrc, status: '',
        });
        count++;
      }
      await new Promise(r => setTimeout(r, 220));
    }
    if (newClients.length > 0) setClients(prev => [...prev, ...newClients]);
    return count;
  }, [clients, leads]);

  // ─── Update a client record in Airtable + local state ────────────────────────
  const updateClient = useCallback((airtableId, atFields, localFields) => {
    updateRecord(AT_TABLES.clients, airtableId, atFields);
    setClients(prev => prev.map(c =>
      c.airtableId === airtableId ? { ...c, ...localFields } : c
    ));
  }, []);

  // ─── Calendar booking operations ─────────────────────────────────────────────

  const addCalBooking = useCallback(async (data) => {
    const localId = `cal-${Date.now()}`;
    const isFromLead = !!data.linkedLeadId;
    const record = {
      id: localId, airtableId: null,
      clientName: data.clientName || '', phone: data.phone || '',
      email: data.email || '', city: data.city || '',
      service: data.service || '', paymentMethod: data.paymentMethod || 'Cash',
      date: data.date || '', bookingStatus: data.bookingStatus || 'Scheduled', amount: data.amount || 0,
      jobTime: data.jobTime || '', assignedWorker: data.assignedWorker || '',
      upsellAmount: 0, upsellNotes: '',
      linkedLeadId: data.linkedLeadId || null,
      bookingSource: isFromLead ? 'Lead' : 'Manual',
    };
    setCalBookings(prev => [record, ...prev]);
    // Encode source in Booking Name: "LEAD::" prefix for lead-sourced bookings
    const bookingName = isFromLead
      ? `LEAD::${record.clientName} - ${record.date}`
      : `${record.clientName} - ${record.date}`;
    const atFields = {
      'Booking Name':    bookingName,
      'Client Name':     record.clientName,
      'Date':            record.date,
      'Job_Service':     record.service,
      'City':            record.city,
      'Phone':           record.phone,
      'Booking Status':  record.bookingStatus || 'Scheduled',
      'Amount':          record.amount || 0,
      'Job Time':        record.jobTime,
      'Assigned Worker': record.assignedWorker,
    };
    const airtableId = await createRecord(AT_TABLES.calendar, atFields);
    if (airtableId) {
      setCalBookings(prev => prev.map(b => b.id === localId ? { ...b, airtableId } : b));
    }
    return localId;
  }, []);

  const removeCalBooking = useCallback((id) => {
    setCalBookings(prev => {
      const booking = prev.find(b => b.id === id);
      if (booking?.airtableId) {
        // Update status to Cancelled in Airtable (don't delete — keep for records)
        updateRecord(AT_TABLES.calendar, booking.airtableId, { 'Booking Status': 'Cancelled' });
      }
      return prev.filter(b => b.id !== id);
    });
  }, []);

  const updateCalBooking = useCallback((id, data) => {
    setCalBookings(prev => {
      const booking = prev.find(b => b.id === id);
      if (booking?.airtableId) {
        const patch = {};
        if (data.clientName    !== undefined) patch['Client Name']    = data.clientName;
        if (data.phone         !== undefined) patch['Phone']          = data.phone;
        if (data.city          !== undefined) patch['City']           = data.city;
        if (data.service       !== undefined) patch['Job_Service']    = data.service;
        if (data.bookingStatus !== undefined) patch['Booking Status'] = data.bookingStatus;
        if (data.amount        !== undefined) patch['Amount']         = data.amount;
        if (data.jobTime       !== undefined) patch['Job Time']       = data.jobTime;
        if (data.assignedWorker !== undefined) patch['Assigned Worker'] = data.assignedWorker;
        if (data.upsellAmount  !== undefined) patch['Upsell Amount']  = data.upsellAmount;
        if (data.upsellNotes   !== undefined) patch['Upsell Notes']   = data.upsellNotes;
        if (Object.keys(patch).length) updateRecord(AT_TABLES.calendar, booking.airtableId, patch);
      }
      return prev.map(b => b.id === id ? { ...b, ...data } : b);
    });
  }, []);

  // Record payment for a calendar booking:
  // - Marks the booking Completed + amount
  // - Creates a Revenue record (counts as income)
  // - FULL SYNC: ensures the job appears in the Leads "Job Done" column —
  //   moves the linked lead to Job Done, or creates a Job Done lead if the
  //   booking was added straight on the Calendar with no lead behind it.
  const recordBookingPayment = useCallback(async (bookingId, paidAmount, paymentMethod) => {
    const booking = calBookings.find(b => b.id === bookingId);
    if (!booking) return;

    // 1. Booking → Completed (Airtable + local)
    if (booking.airtableId) {
      updateRecord(AT_TABLES.calendar, booking.airtableId, {
        'Booking Status': 'Completed',
        'Amount': paidAmount,
      });
    }
    setCalBookings(prev => prev.map(b => b.id === bookingId
      ? { ...b, bookingStatus: 'Completed', amount: paidAmount, paymentMethod }
      : b));

    // 2. Revenue record — calendar booking payments are always completed jobs
    createRecord(AT_TABLES.revenue, {
      'Revenue Name':   `${booking.clientName} - ${booking.service || 'Window Cleaning'}`,
      'Date':           new Date().toISOString().split('T')[0],
      'Client Name':    booking.clientName,
      'Phone':          booking.phone || '',
      'Job_Service':    booking.service || 'Window Cleaning',
      'City':           booking.city || '',
      'Payment_Method': paymentMethod || 'Cash',
      'Amount':         paidAmount,
      'Status':         'Job Done',
    });

    // 3. Find-or-create the Job Done lead (match by linked id, then phone, then name)
    const np = s => (s || '').replace(/\D/g, '');
    const nm = s => (s || '').trim().toLowerCase();
    const match = leads.find(l =>
      (booking.linkedLeadId && l.id === booking.linkedLeadId) ||
      (booking.phone && np(l.phone) && np(l.phone) === np(booking.phone)) ||
      (booking.clientName && nm(l.name) && nm(l.name) === nm(booking.clientName))
    );

    if (match) {
      // Move existing lead to Job Done + record the invoice amount/paid state
      if (match.airtableId) {
        const fields = { 'Final Invoice Amount': paidAmount };
        if (match.status !== 'job_done') fields['Lead Status'] = 'Job Done';
        patchAirtable(match.airtableId, fields);
      }
      setLeads(prev => prev.map(l => l.id === match.id
        ? { ...l, status: 'job_done', progress: 100, invoice: paidAmount, paid: true, paidAmount, paymentMethod }
        : l));
    } else {
      // Calendar-only job → create a Job Done lead so it shows in the column
      const jobType = VALID_JOB_TYPES.has(booking.service) ? booking.service : '';
      const newId = await createRecord(AT_TABLES.leads, {
        'Client Name':          booking.clientName || 'Unknown',
        'Phone Number':         booking.phone || '',
        'Property Type':        jobType,
        'Final Invoice Amount': paidAmount || booking.amount || 0,
        'Lead Status':          'Job Done',
        'Lead Source':          'Other',
        'Inquiry Date':         new Date().toISOString(),
      });
      if (newId) {
        const now = new Date();
        setLeads(prev => [{
          id: newId, airtableId: newId,
          name: booking.clientName || 'Unknown', phone: booking.phone || '', email: '',
          source: 'manual', lp: null, subject: '',
          date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          dateObj: now, address: '', jobType, windows: 0, stories: 0,
          value: 0, invoice: paidAmount || booking.amount || 0, duration: '', followUp: '',
          jobDate: booking.date || '', details: '', status: 'job_done', progress: 100,
          starred: false, notes: '', hasCall: false, tag: '', refuseReason: '',
          paid: true, paidAmount, paymentMethod, city: booking.city || '',
          leadChannel: '', leadSource: 'Other', invoiceNumber: null, invoiceSent: false,
        }, ...prev]);
      }
    }
  }, [calBookings, leads, patchAirtable]);

  // ─── Archive a client (Status = 'Archived' in Airtable, moves to archivedClients) ──
  const archiveClient = useCallback((airtableId) => {
    if (!airtableId) return;
    updateRecord(AT_TABLES.clients, airtableId, { 'Status': 'Archived' });
    setClients(prev => {
      const client = prev.find(c => c.airtableId === airtableId);
      if (client) setArchivedClients(d => [{ ...client, status: 'Archived' }, ...d]);
      return prev.filter(c => c.airtableId !== airtableId);
    });
  }, []);

  // ─── Restore an archived client back to active ────────────────────────────────
  const restoreClient = useCallback((airtableId) => {
    if (!airtableId) return;
    updateRecord(AT_TABLES.clients, airtableId, { 'Status': '' });
    setArchivedClients(prev => {
      const client = prev.find(c => c.airtableId === airtableId);
      if (client) setClients(d => [{ ...client, status: '' }, ...d]);
      return prev.filter(c => c.airtableId !== airtableId);
    });
  }, []);

  // ─── Permanently delete a client from Airtable ───────────────────────────────
  const permanentDeleteClient = useCallback((airtableId, fromArchived = false) => {
    if (!airtableId) return;
    deleteRecord(AT_TABLES.clients, airtableId);
    if (fromArchived) {
      setArchivedClients(prev => prev.filter(c => c.airtableId !== airtableId));
    } else {
      setClients(prev => prev.filter(c => c.airtableId !== airtableId));
    }
  }, []);

  return {
    leads, deletedLeads, calBookings, clients, isLoading, fetchLeads,
    changeStatus, toggleStar, saveNote, saveJobType,
    savePaidInfo, saveCity, saveJobDate, saveEmail, saveQuoteAmount, clearQuoteAmount,
    renameLead, setRefuseReason,
    archiveLead, permanentDelete, recoverLead, addLead,
    addCalBooking, removeCalBooking, updateCalBooking, recordBookingPayment,
    deletePayment, syncToClients, upsertClient, syncClientsFromLeads, updateClient,
    archivedClients, archiveClient, restoreClient, permanentDeleteClient,
  };
}
