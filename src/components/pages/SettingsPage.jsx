// Settings → Quote Follow-ups (owner only). Edits the single followup_settings
// row that the Cloud Run job (whatsapp-service/followup.js) reads every 15 min.
// The preview uses the same template rules as the sender (followupTemplate.js).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import { USE_SUPABASE, saveFollowupSettings, countActiveFollowups } from '../../utils/supabaseClient';
import { DEFAULT_STEPS, PLACEHOLDERS, STEP_WAIT_LABELS, renderTemplate, sampleContext, validateSettings } from '../../utils/followupTemplate';

const card  = { background: '#fff', border: '1.5px solid var(--gray-200)', borderRadius: '10px', padding: '16px', marginBottom: '12px' };
const lbl   = { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '.05em', display: 'block', marginBottom: '6px' };
const field = { width: '100%', padding: '9px 11px', fontSize: '14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontFamily: 'inherit', boxSizing: 'border-box', background: '#fff', color: 'var(--gray-900)' };
const row   = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' };
const title = { fontSize: '14px', fontWeight: 700, color: 'var(--gray-900)' };
const hourLabel = h => (h === 0 || h === 24 ? '12am' : h === 12 ? '12pm' : h < 12 ? `${h}am` : `${h - 12}pm`);

function Toggle({ on, onChange, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={!!on} aria-label={label} onClick={() => onChange(!on)}
      style={{ width: '44px', height: '26px', borderRadius: '13px', border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, background: on ? 'var(--primary)' : 'var(--gray-300)', transition: 'background .15s' }}
    >
      <span style={{ position: 'absolute', top: '3px', left: on ? '21px' : '3px', width: '20px', height: '20px', borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .15s' }} />
    </button>
  );
}

function StepCard({ index, step, ctx, onChange }) {
  const bodyRef = useRef(null);
  const [unit, setUnit] = useState(step.delay_hours % 24 === 0 ? 'days' : 'hours');
  const amount = unit === 'days' ? step.delay_hours / 24 : step.delay_hours;
  const set = patch => onChange({ ...step, ...patch });

  function setAmount(v) {
    const n = parseFloat(v);
    set({ delay_hours: Number.isFinite(n) ? Math.round(n * (unit === 'days' ? 24 : 1)) : 0 });
  }

  function insertPlaceholder(key) {
    const token = `{${key}}`;
    const el = bodyRef.current;
    if (!el) { set({ body: `${step.body}${token}` }); return; }
    const a = el.selectionStart ?? step.body.length;
    const b = el.selectionEnd ?? a;
    set({ body: step.body.slice(0, a) + token + step.body.slice(b) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + token.length, a + token.length); });
  }

  return (
    <div style={{ ...card, opacity: step.enabled ? 1 : 0.65 }}>
      <div style={{ ...row, marginBottom: '12px' }}>
        <div>
          <div style={title}>Follow-up {index + 1}{index === 2 ? ' — final' : ''}</div>
          {index === 2 && <div style={{ fontSize: '12px', color: 'var(--gray-500)', marginTop: '2px' }}>After this one sends, the lead moves to Refused.</div>}
        </div>
        <Toggle on={step.enabled} onChange={v => set({ enabled: v })} label={`Follow-up ${index + 1} on/off`} />
      </div>

      <label style={lbl}>When</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <input type="number" min="1" step="1" value={amount} onChange={e => setAmount(e.target.value)} style={{ ...field, width: '80px' }} />
        <select value={unit} onChange={e => setUnit(e.target.value)} style={{ ...field, width: 'auto' }}>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <span style={{ fontSize: '13px', color: 'var(--gray-600)' }}>{STEP_WAIT_LABELS[index]}</span>
      </div>

      <label style={lbl}>Subject</label>
      <input value={step.subject} onChange={e => set({ subject: e.target.value })} style={{ ...field, marginBottom: '12px' }} />

      <label style={lbl}>Message</label>
      <textarea ref={bodyRef} rows={9} value={step.body} onChange={e => set({ body: e.target.value })} style={{ ...field, resize: 'vertical', lineHeight: 1.5 }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0 12px' }}>
        {PLACEHOLDERS.map(p => (
          <button
            key={p.key} type="button" onClick={() => insertPlaceholder(p.key)}
            style={{ fontSize: '11.5px', fontWeight: 600, padding: '5px 10px', borderRadius: '20px', border: '1px solid var(--gray-200)', background: 'var(--gray-50)', color: 'var(--gray-600)', cursor: 'pointer', fontFamily: 'inherit' }}
          >
            + {p.label}
          </button>
        ))}
      </div>

      <label style={lbl}>Preview</label>
      <div style={{ background: 'var(--gray-50)', border: '1px solid var(--gray-200)', borderRadius: '8px', padding: '12px', fontSize: '13px', color: 'var(--gray-800)', lineHeight: 1.55 }}>
        <div style={{ fontWeight: 700, marginBottom: '8px' }}>{renderTemplate(step.subject, ctx)}</div>
        <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{renderTemplate(step.body, ctx)}</div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { followupSettings, setFollowupSettings, showToast } = useLeadsContext();
  const [draft, setDraft] = useState(followupSettings);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [activeCount, setActiveCount] = useState(null);

  useEffect(() => { setDraft(followupSettings); setErrors([]); }, [followupSettings]);
  useEffect(() => { if (followupSettings) countActiveFollowups().then(setActiveCount); }, [followupSettings]);

  const ctx = useMemo(() => sampleContext(draft), [draft]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(followupSettings);

  const header = (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Quote Follow-ups</div>
      <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>
        Automatic emails to customers who were sent a quote but haven't replied.
      </div>
    </div>
  );

  if (!USE_SUPABASE || !draft) {
    return (
      <div className="page">
        {header}
        <div style={card}><div style={{ fontSize: '14px', color: 'var(--gray-600)' }}>Follow-ups aren't set up for this branch yet.</div></div>
      </div>
    );
  }

  const set = patch => setDraft(d => ({ ...d, ...patch }));
  const setStep = (i, step) => setDraft(d => ({ ...d, steps: d.steps.map((s, j) => (j === i ? step : s)) }));

  async function save() {
    const errs = validateSettings(draft);
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    try {
      const { id, updated_at, ...patch } = draft;
      const saved = await saveFollowupSettings(patch);
      if (saved) {
        setFollowupSettings(saved);
        showToast('Follow-up settings saved');
      } else {
        showToast('Save failed — not saved (are you logged in as the owner?)');
      }
    } catch (e) {
      showToast(`Save failed — ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  const canSave = dirty && !saving;

  return (
    <div className="page" style={{ maxWidth: '760px' }}>
      {header}

      <div style={card}>
        <div style={row}>
          <div>
            <div style={title}>Automatic follow-ups</div>
            <div style={{ fontSize: '12.5px', color: 'var(--gray-500)', marginTop: '2px' }}>
              {draft.enabled
                ? `On — ${activeCount ?? '…'} lead${activeCount === 1 ? '' : 's'} in a sequence · checked every 15 min`
                : 'Off — no follow-up emails are sent and new quotes are not enrolled.'}
            </div>
          </div>
          <Toggle on={draft.enabled} onChange={v => set({ enabled: v })} label="Automatic follow-ups on/off" />
        </div>
      </div>

      <div style={{ ...card, ...(draft.test_mode ? { background: '#fffbeb', borderColor: '#fde68a' } : {}) }}>
        <div style={row}>
          <div>
            <div style={title}>Test mode</div>
            <div style={{ fontSize: '12.5px', color: draft.test_mode ? '#92400e' : 'var(--gray-500)', marginTop: '2px' }}>
              {draft.test_mode
                ? 'Only leads whose name starts with TEST are emailed — and only to the test address below. Real leads are held.'
                : 'Off — follow-ups go to real customers.'}
            </div>
          </div>
          <Toggle on={draft.test_mode} onChange={v => set({ test_mode: v })} label="Test mode on/off" />
        </div>
        {draft.test_mode && (
          <div style={{ marginTop: '12px' }}>
            <label style={lbl}>Send test emails to</label>
            <input type="email" value={draft.test_email || ''} placeholder="you@example.com" onChange={e => set({ test_email: e.target.value })} style={field} />
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
          <div>
            <label style={lbl}>Signature (sign-off)</label>
            <input value={draft.sender_name || ''} onChange={e => set({ sender_name: e.target.value })} style={field} />
          </div>
          <div>
            <label style={lbl}>Company name</label>
            <input value={draft.company_name || ''} onChange={e => set({ company_name: e.target.value })} style={field} />
          </div>
        </div>
        <label style={{ ...lbl, marginTop: '12px' }}>Only send between</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <select value={draft.window_start_hour} onChange={e => set({ window_start_hour: parseInt(e.target.value, 10) })} style={{ ...field, width: 'auto' }}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <span style={{ fontSize: '13px', color: 'var(--gray-600)' }}>and</span>
          <select value={draft.window_end_hour} onChange={e => set({ window_end_hour: parseInt(e.target.value, 10) })} style={{ ...field, width: 'auto' }}>
            {Array.from({ length: 24 }, (_, i) => i + 1).map(h => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
        </div>
      </div>

      {(draft.steps || []).map((step, i) => (
        <StepCard key={i} index={i} step={step} ctx={ctx} onChange={s => setStep(i, s)} />
      ))}

      {errors.length > 0 && (
        <div style={{ ...card, background: '#fef2f2', borderColor: '#fecaca', color: '#b91c1c', fontSize: '13px' }}>
          {errors.map(e => <div key={e}>• {e}</div>)}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '24px' }}>
        <button
          onClick={save} disabled={!canSave}
          style={{ flex: '1 1 200px', minHeight: '44px', background: canSave ? 'var(--primary)' : '#9ca3af', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: 700, cursor: canSave ? 'pointer' : 'default', fontFamily: 'inherit' }}
        >
          {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
        <button
          onClick={() => set({ steps: DEFAULT_STEPS.map(s => ({ ...s })) })}
          style={{ minHeight: '44px', padding: '0 16px', background: '#fff', color: 'var(--gray-600)', border: '1.5px solid var(--gray-200)', borderRadius: '8px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Reset to default scripts
        </button>
      </div>
    </div>
  );
}
