/**
 * Generic Airtable CRUD + fetch utilities for non-leads tables.
 * Used by ExpensesPage, CalendarPage, ReportsPage, DetailPanel, etc.
 *
 * Required .env vars:
 *   VITE_AIRTABLE_TOKEN              — Personal Access Token
 *   VITE_AIRTABLE_BASE_ID            — Base ID (same base as leads)
 *   VITE_AIRTABLE_EXPENSES_TABLE_ID  — Table ID/name for Expenses
 *   VITE_AIRTABLE_CALENDAR_TABLE_ID  — Table ID/name for Bookings
 *   VITE_AIRTABLE_REVENUE_TABLE_ID   — Table ID/name for Revenue
 *   VITE_AIRTABLE_REFUSED_TABLE_ID   — Table ID/name for Refused
 */

import { USE_SUPABASE, sbCreate, sbUpdate, sbDelete, sbFetch } from './supabaseClient';

const IS_LOCAL = import.meta.env.DEV;
const AT_TOKEN = import.meta.env.VITE_AIRTABLE_TOKEN || '';
const AT_BASE  = import.meta.env.VITE_AIRTABLE_BASE_ID || '';

export const AT_TABLES = {
  leads:    import.meta.env.VITE_AIRTABLE_TABLE_ID          || 'Leads',
  expenses: import.meta.env.VITE_AIRTABLE_EXPENSES_TABLE_ID || 'Expenses',
  calendar: import.meta.env.VITE_AIRTABLE_CALENDAR_TABLE_ID || 'Bookings',
  revenue:  import.meta.env.VITE_AIRTABLE_REVENUE_TABLE_ID  || 'Revenue',
  refused:  import.meta.env.VITE_AIRTABLE_REFUSED_TABLE_ID  || 'Refused',
  clients:  import.meta.env.VITE_AIRTABLE_CLIENTS_TABLE_ID  || 'Clients',
};

// ─── Fetch all records from a table (handles Airtable pagination) ─────────────
// Returns an array of raw Airtable record objects: [{ id, fields }, ...]
export async function fetchRecords(tableId) {
  if (!tableId) return [];
  if (USE_SUPABASE) return sbFetch(tableId);
  const allRecords = [];
  let offset = '';
  try {
    if (IS_LOCAL) {
      do {
        const url = `https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(tableId)}?pageSize=100${offset ? '&offset=' + encodeURIComponent(offset) : ''}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${AT_TOKEN}` } });
        if (!res.ok) { console.error('fetchRecords failed', tableId, res.status); return []; }
        const data = await res.json();
        allRecords.push(...(data.records || []));
        offset = data.offset || '';
      } while (offset);
      return allRecords;
    } else {
      const res = await fetch(`/api/fetch-records?tableId=${encodeURIComponent(tableId)}`);
      if (!res.ok) { console.error('fetchRecords API failed', tableId, res.status); return []; }
      const data = await res.json();
      return data.records || [];
    }
  } catch (err) {
    console.error('fetchRecords error:', tableId, err);
    return [];
  }
}

// ─── Create a new record ──────────────────────────────────────────────────────
// Returns the new Airtable record ID, or null on failure.
export async function createRecord(tableId, fields) {
  if (!tableId) return null;
  if (USE_SUPABASE) return sbCreate(tableId, fields);
  try {
    if (IS_LOCAL) {
      const res = await fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(tableId)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields, typecast: true }),
      });
      if (!res.ok) { console.error('createRecord failed', await res.json()); return null; }
      const data = await res.json();
      return data.id || null;
    } else {
      const res = await fetch('/api/create-record', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableId, fields, typecast: true }),
      });
      if (!res.ok) { console.error('createRecord API failed', await res.json()); return null; }
      const data = await res.json();
      return data.id || null;
    }
  } catch (err) {
    console.error('createRecord error:', err);
    return null;
  }
}

// ─── Update fields on an existing record (fire-and-forget) ───────────────────
export function updateRecord(tableId, recordId, fields) {
  if (!tableId || !recordId) return;
  if (USE_SUPABASE) { sbUpdate(tableId, recordId, fields); return; }
  if (IS_LOCAL) {
    fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(tableId)}/${recordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    })
      .then(r => { if (!r.ok) r.json().then(e => console.error('updateRecord failed:', e)); })
      .catch(err => console.error('updateRecord error:', err));
  } else {
    fetch('/api/update-record', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, recordId, fields }),
    }).catch(err => console.error('updateRecord error:', err));
  }
}

// ─── Delete a record (returns Promise so callers can await if needed) ────────
export function deleteRecord(tableId, recordId) {
  if (!tableId || !recordId) return Promise.resolve();
  if (USE_SUPABASE) return sbDelete(tableId, recordId);
  if (IS_LOCAL) {
    return fetch(`https://api.airtable.com/v0/${AT_BASE}/${encodeURIComponent(tableId)}/${recordId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AT_TOKEN}` },
    })
      .then(r => { if (!r.ok) r.json().then(e => console.error('deleteRecord failed:', e)); })
      .catch(err => console.error('deleteRecord error:', err));
  } else {
    return fetch('/api/delete-record', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, recordId }),
    }).catch(err => console.error('deleteRecord error:', err));
  }
}
