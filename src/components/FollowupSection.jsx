// Quote follow-up status, send history and Stop/Start inside the lead detail
// panel (owner only). Status text + which button to show come from
// describeFollowup() so the rules stay unit-tested.
import { useEffect, useState } from 'react';
import { useLeadsContext } from '../context/LeadsContext';
import { fetchFollowupLog } from '../utils/supabaseClient';
import { describeFollowup } from '../utils/followupTemplate';

const TONES = {
  info:  { bg: '#f5f3ff', border: '#ddd6fe', color: '#5b21b6' },
  ok:    { bg: '#f0fdf4', border: '#bbf7d0', color: '#15803d' },
  warn:  { bg: '#fffbeb', border: '#fde68a', color: '#92400e' },
  muted: { bg: 'var(--gray-50)', border: 'var(--gray-200)', color: 'var(--gray-600)' },
};
const LABELS = { stop: 'Stop follow-ups', start: 'Start follow-ups', resume: 'Resume follow-ups' };
const fmt = iso => new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function FollowupSection({ lead }) {
  const { followupSettings, startFollowups, stopFollowups, showToast } = useLeadsContext();
  const [log, setLog] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLog([]);
    if (lead?.airtableId && followupSettings) fetchFollowupLog(lead.airtableId).then(rows => { if (alive) setLog(rows); });
    return () => { alive = false; };
  }, [lead?.airtableId, lead?.followupStep, lead?.followupStatus, followupSettings]);

  const info = describeFollowup(lead, followupSettings);
  if (!info) return null;
  const t = TONES[info.tone] || TONES.muted;
  const isStop = info.action === 'stop';

  async function act() {
    setBusy(true);
    const ok = isStop ? await stopFollowups(lead.id) : await startFollowups(lead.id);
    setBusy(false);
    showToast(!ok ? 'Could not update follow-ups — try again'
      : isStop ? 'Follow-ups stopped' : 'Follow-ups on — the next email goes at the next check');
  }

  return (
    <div className="psec">
      <div className="psec-title">Quote Follow-ups</div>
      <div style={{ background: t.bg, border: `1.5px solid ${t.border}`, borderRadius: '10px', padding: '10px 12px', fontSize: '12.5px', fontWeight: 600, color: t.color, lineHeight: 1.45 }}>
        {info.text}
      </div>
      {log.length > 0 && (
        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {log.map((r, i) => (
            <div key={i} style={{ fontSize: '11.5px', color: r.error ? '#b91c1c' : 'var(--gray-600)', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              <strong>FU{r.step}</strong>
              <span>{fmt(r.sent_at)}</span>
              <span style={{ wordBreak: 'break-all' }}>{r.error ? `failed: ${r.error}` : `→ ${r.to_email}`}</span>
              {r.test_mode && <span style={{ fontWeight: 700, color: '#92400e' }}>TEST</span>}
            </div>
          ))}
        </div>
      )}
      {info.action && (
        <button
          onClick={act} disabled={busy}
          style={{ marginTop: '10px', width: '100%', minHeight: '44px', borderRadius: '8px', fontSize: '13px', fontWeight: 700, fontFamily: 'inherit', cursor: busy ? 'default' : 'pointer',
            background: isStop ? '#fff' : 'var(--primary)', color: isStop ? '#b91c1c' : '#fff', border: isStop ? '1.5px solid #fecaca' : 'none' }}
        >
          {busy ? 'Saving…' : LABELS[info.action]}
        </button>
      )}
    </div>
  );
}
