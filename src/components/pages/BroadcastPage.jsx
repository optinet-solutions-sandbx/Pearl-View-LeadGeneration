import { useState, useEffect, useMemo } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import BroadcastConfirmModal from '../BroadcastConfirmModal';

const IS_LOCAL = import.meta.env.DEV;
const MM_USER = import.meta.env.VITE_MM_USERNAME     || '';
const MM_PASS = import.meta.env.VITE_MM_API_PASSWORD || '';
const MM_LIST = import.meta.env.VITE_MM_LIST_ID      || '';

// SMS char accounting — GSM-7 = 160 / 153 (multipart). UCS-2 (Unicode) = 70 / 67.
// We pick automatically based on whether the message contains non-GSM chars.
const GSM_CHARS = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

function smsParts(message) {
  const text = String(message || '');
  if (!text.length) return { length: 0, parts: 0, encoding: 'GSM-7' };
  const isUnicode = [...text].some(ch => !GSM_CHARS.includes(ch) && !GSM_EXT.includes(ch));
  // GSM extended chars count as 2 each. Per-SMS limit: 160 / 153 for multipart.
  let chars = 0;
  for (const ch of text) {
    if (isUnicode) chars += 1;
    else chars += GSM_EXT.includes(ch) ? 2 : 1;
  }
  const single = isUnicode ? 70 : 160;
  const multi  = isUnicode ? 67 : 153;
  const parts = chars <= single ? 1 : Math.ceil(chars / multi);
  return { length: chars, parts, encoding: isUnicode ? 'Unicode' : 'GSM-7' };
}

async function fetchListInfo() {
  if (IS_LOCAL) {
    if (!MM_USER || !MM_PASS || !MM_LIST) return null;
    const auth = btoa(`${MM_USER}:${MM_PASS}`);
    const headers = { Authorization: `Basic ${auth}` };
    const [lists, senders] = await Promise.all([
      fetch('/mm-api/v1/lists',   { headers }).then(r => r.json()).catch(() => null),
      fetch('/mm-api/v1/senders', { headers }).then(r => r.json()).catch(() => null),
    ]);
    const list = (lists?.results || []).find(l => String(l.list_id) === String(MM_LIST)) || null;
    return { list, senders: senders?.results || [], balance: null };
  }
  return fetch('/api/mm-list-info').then(r => r.json()).catch(() => null);
}

async function sendBroadcast({ message, sender, scheduledFor, customRef }) {
  if (IS_LOCAL) {
    if (!MM_USER || !MM_PASS || !MM_LIST) {
      return { ok: false, error: 'Missing local MM env vars' };
    }
    const auth = btoa(`${MM_USER}:${MM_PASS}`);
    const body = {
      list_id: Number(MM_LIST),
      sender,
      message,
      stagger_minutes: 5,
    };
    if (scheduledFor) body.scheduled_for = scheduledFor;
    if (customRef)    body.custom_ref    = customRef;
    const r = await fetch('/mm-api/v1/list-send', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
  }
  const r = await fetch('/api/mm-send-broadcast', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sender, scheduledFor, customRef }),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

export default function BroadcastPage() {
  const { showToast } = useLeadsContext();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [sender, setSender]   = useState('');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    fetchListInfo()
      .then(d => {
        setInfo(d);
        const def = (d?.senders || []).find(s => s.is_default);
        if (def) setSender(def.sender);
      })
      .finally(() => setLoading(false));
  }, []);

  const stats = useMemo(() => smsParts(message), [message]);
  const recipientCount = info?.list?.contact_count || 0;
  const totalSmsUnits  = stats.parts * recipientCount;

  function handleInsert(token) {
    setMessage(prev => prev + token);
  }

  function handleSendClick() {
    if (!message.trim()) { showToast('Message is empty'); return; }
    if (!sender)         { showToast('Pick a sender'); return; }
    if (!recipientCount) { showToast('Broadcast list is empty'); return; }
    if (scheduleEnabled && !scheduledFor) { showToast('Pick a date + time to schedule'); return; }
    setConfirmOpen(true);
  }

  async function handleConfirmSend() {
    setSending(true);
    const customRef = `dashboard-${Date.now()}`;
    let scheduledIso = null;
    if (scheduleEnabled && scheduledFor) {
      // datetime-local gives local time without timezone; MM expects UTC ISO 8601.
      scheduledIso = new Date(scheduledFor).toISOString();
    }
    const result = await sendBroadcast({
      message: message.trim(),
      sender,
      scheduledFor: scheduledIso,
      customRef,
    });
    setSending(false);
    setConfirmOpen(false);
    if (result.ok) {
      const sent = result.data?.recipient_count ?? recipientCount;
      showToast(scheduleEnabled ? `Scheduled to ${sent} contacts` : `Sent to ${sent} contacts`);
      setMessage('');
      // Refresh list info (contact_count may have shifted as MM filters unsubs)
      fetchListInfo().then(setInfo).catch(() => {});
    } else {
      const err = result.data?.error || result.data?.message || `Status ${result.status}`;
      showToast(`Send failed: ${err}`);
    }
  }

  if (loading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
        <div style={{ color: 'var(--gray-400)', fontSize: '14px' }}>Loading Mobile Message…</div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="page">
        <div style={{ background: '#fef2f2', border: '1.5px solid #fecaca', color: '#991b1b', borderRadius: '12px', padding: '16px', fontSize: '13px' }}>
          Couldn't reach Mobile Message. Check your MM credentials in the environment.
        </div>
      </div>
    );
  }

  const senders = info.senders || [];
  const balance = info.balance;

  return (
    <div className="page">
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Broadcast SMS</div>
        <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>
          Send a bulk SMS to every contact in the <strong>{info.list?.name || 'broadcast'}</strong> list.
        </div>
      </div>

      {/* Top stat cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', marginBottom: '16px' }}>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Recipients</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--gray-900)', marginTop: '4px' }}>{recipientCount}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>contacts on list</div>
        </div>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>SMS Parts</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: stats.parts > 1 ? '#c2410c' : 'var(--gray-900)', marginTop: '4px' }}>
            {stats.parts || 0}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>
            {stats.length} chars · {stats.encoding}
          </div>
        </div>
        <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total SMS Units</div>
          <div style={{ fontSize: '24px', fontWeight: 800, color: '#0d9488', marginTop: '4px' }}>{totalSmsUnits}</div>
          <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>parts × recipients</div>
        </div>
        {balance != null && (balance.credits != null || typeof balance === 'number') && (
          <div style={{ background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '14px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em' }}>MM Credits</div>
            <div style={{ fontSize: '24px', fontWeight: 800, color: 'var(--gray-900)', marginTop: '4px' }}>
              {balance.credits ?? balance}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>available</div>
          </div>
        )}
      </div>

      {/* Composer card */}
      <div style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: '12px', padding: '20px' }}>
        <div className="fgroup" style={{ margin: 0, marginBottom: '14px' }}>
          <label className="flabel">Send from</label>
          <select className="fselect" value={sender} onChange={e => setSender(e.target.value)}>
            <option value="">— Pick a sender —</option>
            {senders.map(s => (
              <option key={s.sender} value={s.sender}>
                {s.label} · {s.sender}{s.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="fgroup" style={{ margin: 0 }}>
          <label className="flabel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>Message</span>
            <span style={{ fontSize: '11px', fontWeight: 500, color: stats.parts > 1 ? '#c2410c' : 'var(--gray-500)' }}>
              {stats.length} chars · {stats.parts} part{stats.parts === 1 ? '' : 's'}
            </span>
          </label>
          <textarea
            rows={6}
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="Hi {first_name}, just a reminder that your windows are due for a clean — reply YES to book.{optout}"
            style={{ width: '100%', padding: '12px 14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontSize: '14px', fontFamily: 'inherit', resize: 'vertical', lineHeight: '1.5', boxSizing: 'border-box' }}
          />
        </div>

        {/* Token shortcuts */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' }}>
          <div style={{ fontSize: '11px', color: 'var(--gray-500)', alignSelf: 'center', marginRight: '4px' }}>Insert:</div>
          {['{first_name}', '{last_name}', '{optout}'].map(tok => (
            <button
              key={tok}
              type="button"
              onClick={() => handleInsert(tok)}
              style={{ padding: '4px 10px', background: '#f1f5f9', color: 'var(--gray-700)', border: '1px solid var(--gray-200)', borderRadius: '6px', fontSize: '11.5px', fontFamily: 'monospace', cursor: 'pointer' }}
            >
              {tok}
            </button>
          ))}
        </div>

        {/* Schedule toggle */}
        <div style={{ marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--gray-100)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', color: 'var(--gray-700)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={scheduleEnabled}
              onChange={e => setScheduleEnabled(e.target.checked)}
              style={{ width: '16px', height: '16px' }}
            />
            Schedule for later instead of sending now
          </label>
          {scheduleEnabled && (
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={e => setScheduledFor(e.target.value)}
              min={new Date(Date.now() + 5 * 60_000).toISOString().slice(0, 16)}
              className="finput"
              style={{ marginTop: '10px', maxWidth: '260px' }}
            />
          )}
        </div>

        {/* Tips */}
        <div style={{ marginTop: '14px', padding: '10px 12px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', fontSize: '12px', color: '#92400e', lineHeight: '1.5' }}>
          <strong>Tips:</strong> Use <code style={{ fontFamily: 'monospace' }}>{'{first_name}'}</code> for personalisation. Australian SPAM Act requires an opt-out — append <code style={{ fontFamily: 'monospace' }}>{'{optout}'}</code> and Mobile Message inserts a 20-character unsubscribe instruction automatically.
        </div>

        {/* Send button */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
          <button
            onClick={handleSendClick}
            disabled={!message.trim() || !sender || !recipientCount}
            style={{
              padding: '11px 24px',
              background: (!message.trim() || !sender || !recipientCount) ? 'var(--gray-300)' : 'var(--primary)',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              fontSize: '13px',
              fontWeight: 700,
              cursor: (!message.trim() || !sender || !recipientCount) ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              minHeight: '44px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5" style={{ width: '15px', height: '15px' }}>
              <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/>
            </svg>
            {scheduleEnabled ? 'Schedule Broadcast' : 'Send Broadcast'}
          </button>
        </div>
      </div>

      <BroadcastConfirmModal
        open={confirmOpen}
        message={message}
        sender={sender}
        senderLabel={senders.find(s => s.sender === sender)?.label || ''}
        recipientCount={recipientCount}
        parts={stats.parts}
        totalSmsUnits={totalSmsUnits}
        scheduledFor={scheduleEnabled ? scheduledFor : null}
        sending={sending}
        onConfirm={handleConfirmSend}
        onCancel={() => !sending && setConfirmOpen(false)}
      />
    </div>
  );
}
