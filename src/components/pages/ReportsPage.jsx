import { useState, useEffect, useMemo, useRef } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import { fetchRecords, AT_TABLES } from '../../utils/airtableSync';

const RANGES = [
  { id: 'week',   label: 'Week' },
  { id: 'month',  label: 'Month' },
  { id: 'year',   label: 'Year' },
  { id: 'custom', label: 'Custom' },
];

const SOURCE_META = {
  'website-pearlview':  { label: 'Pearl View',   color: '#2563eb', bg: '#eff6ff' },
  'website-crystalpro': { label: 'Crystal Pro',  color: '#7c3aed', bg: '#f5f3ff' },
  'Phone Call':         { label: 'Phone Call',   color: '#0d9488', bg: '#f0fdfa' },
  'Facebook':           { label: 'Facebook',     color: '#1877f2', bg: '#eff6ff' },
  'Google':             { label: 'Google',       color: '#dc2626', bg: '#fef2f2' },
  'Other':              { label: 'Other',        color: '#6b7280', bg: '#f9fafb' },
  'Manual':             { label: 'Manual',       color: '#94a3b8', bg: '#f8fafc' },
};

function getSourceMeta(key) {
  return SOURCE_META[key] || { label: key || 'Unknown', color: '#6b7280', bg: '#f9fafb' };
}

function startOf(type) {
  const d = new Date();
  if (type === 'week')  { d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); return d; }
  if (type === 'month') { d.setDate(1); d.setHours(0,0,0,0); return d; }
  if (type === 'year')  { d.setMonth(0,1); d.setHours(0,0,0,0); return d; }
  return null;
}

// ── Finance chart helpers ─────────────────────────────────────────────────────
function smoothPath(pts) {
  if (!pts || pts.length < 2) return '';
  if (pts.length === 2) return `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)} L${pts[1][0].toFixed(1)},${pts[1][1].toFixed(1)}`;
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1);
    const cp1y = (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1);
    const cp2x = (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1);
    const cp2y = (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1);
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${(+p2[0]).toFixed(1)},${(+p2[1]).toFixed(1)}`;
  }
  return d;
}

// Bucket revenue + expenses into sensible time buckets for the grouped-bar chart:
//   week  → 7 daily bars      month → weekly bars (~4-5)
//   year  → 12 monthly bars   custom → daily / weekly / monthly by span
// Fewer, wider buckets read far cleaner than 30 spiky daily points.
function buildPeriods(range, from, to, revenues, expenses) {
  if (!from || !to) return [];
  const rev = revenues || [], exp = expenses || [];
  const sumIn = (s, e) => rev.filter(r => { const d = new Date(r.date); return d >= s && d <= e; }).reduce((a, r) => a + r.amount, 0);
  const sumEx = (s, e) => exp.filter(r => { const d = new Date(r.date); return d >= s && d <= e; }).reduce((a, r) => a + r.amount, 0);
  const bucket = (s, e, label) => ({ label, income: sumIn(s, e), exp: sumEx(s, e) });

  if (range === 'year') {
    return Array.from({ length: 12 }, (_, m) => {
      const s = new Date(from.getFullYear(), m, 1);
      const e = new Date(from.getFullYear(), m + 1, 0, 23, 59, 59);
      return bucket(s, e, s.toLocaleDateString('en-AU', { month: 'short' }));
    });
  }

  const spanDays = Math.round((to - from) / 86400000) + 1;
  const step = range === 'week' ? 1
             : range === 'month' ? 7
             : (spanDays <= 16 ? 1 : spanDays <= 92 ? 7 : 30); // custom

  const out = [];
  const cur = new Date(from); cur.setHours(0, 0, 0, 0);
  const end = new Date(to);   end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const s = new Date(cur);
    const e = new Date(cur); e.setDate(e.getDate() + step - 1); e.setHours(23, 59, 59, 999);
    if (e > end) e.setTime(end.getTime());
    const label = step === 1
      ? (range === 'week' ? s.toLocaleDateString('en-AU', { weekday: 'short' })
                          : s.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }))
      : s.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
    out.push(bucket(s, e, label));
    cur.setDate(cur.getDate() + step);
  }
  return out;
}

// ── Expense category line chart helpers ──────────────────────────────────────
const CAT_COLORS = ['#2563eb', '#0d9488', '#dc2626', '#d97706', '#7c3aed', '#ea580c', '#0891b2', '#16a34a', '#f43f5e'];

function buildExpensePeriods(range, from, to, expenses) {
  if (!from || !to || !expenses.length) return { labels: [], series: [] };
  const cats = [...new Set(expenses.map(e => e.category))].filter(Boolean);
  if (range === 'year') {
    const labels = Array.from({ length: 12 }, (_, m) =>
      new Date(from.getFullYear(), m, 1).toLocaleDateString('en-AU', { month: 'short' })
    );
    return {
      labels,
      series: cats.map(cat => ({
        label: cat,
        data: Array.from({ length: 12 }, (_, m) => {
          const s = new Date(from.getFullYear(), m, 1);
          const e = new Date(from.getFullYear(), m + 1, 0, 23, 59, 59);
          return expenses.filter(ex => ex.category === cat && new Date(ex.date) >= s && new Date(ex.date) <= e).reduce((a, ex) => a + ex.amount, 0);
        }),
      })),
    };
  }
  const labels = [];
  const seriesData = Object.fromEntries(cats.map(c => [c, []]));
  const cur = new Date(from); cur.setHours(0, 0, 0, 0);
  const end = new Date(to);   end.setHours(23, 59, 59, 999);
  while (cur <= end) {
    const ds = cur.toDateString();
    const label = range === 'week'
      ? cur.toLocaleDateString('en-AU', { weekday: 'short' })
      : (labels.length === 0 || cur.getDate() === 1
          ? cur.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })
          : String(cur.getDate()));
    labels.push(label);
    cats.forEach(cat => {
      seriesData[cat].push(expenses.filter(e => e.category === cat && new Date(e.date).toDateString() === ds).reduce((a, e) => a + e.amount, 0));
    });
    cur.setDate(cur.getDate() + 1);
  }
  return { labels, series: cats.map(c => ({ label: c, data: seriesData[c] })) };
}

function ExpensesLineChart({ expenses, range, from, to }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const W = 320, H = 160, PL = 4, PR = 4, PT = 26, PB = 26;
  const cW = W - PL - PR, cH = H - PT - PB;
  const floorY = PT + cH;

  const { labels, series } = useMemo(
    () => buildExpensePeriods(range, from, to, expenses),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, from?.getTime(), to?.getTime(), expenses]
  );

  const activeSeries = series.filter(s => s.data.some(v => v > 0));
  const hasData = activeSeries.length > 0;

  const n       = (hasData ? labels : ['']).length || 1;
  const rawMax  = hasData ? Math.max(...activeSeries.flatMap(s => s.data), 1) : 1;
  const niceStep = (() => {
    const rough = rawMax / 4;
    const exp   = Math.pow(10, Math.floor(Math.log10(rough)));
    return [1, 2, 2.5, 5, 10].map(s => s * exp).find(s => s >= rough) || exp * 10;
  })();
  const maxVal = Math.ceil(rawMax / niceStep) * niceStep;
  const xOf = i => PL + (n <= 1 ? cW / 2 : (i / (n - 1)) * cW);
  const yOf = v => PT + cH - (v / maxVal) * cH;
  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = niceStep * i;
    return { y: yOf(v), label: v >= 1000 ? `$${(v/1000).toFixed(v%1000===0?0:1)}k` : `$${Math.round(v)}` };
  });
  const labelEvery = n <= 31 ? 1 : n <= 60 ? 2 : Math.ceil(n / 12);
  const hX = hoverIdx !== null ? xOf(hoverIdx) : null;
  const tipPct = hoverIdx !== null ? (xOf(hoverIdx) / W * 100) : 50;

  function onMove(e) {
    const r     = e.currentTarget.getBoundingClientRect();
    const svgX  = ((e.clientX - r.left) / r.width) * W;
    const plotX = Math.max(0, Math.min(cW, svgX - PL));
    setHoverIdx(Math.max(0, Math.min(n - 1, Math.round((plotX / cW) * (n - 1)))));
  }

  return (
    <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid var(--gray-200)', padding: '16px 16px 10px', marginBottom: '14px' }}>
      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--gray-800)', marginBottom: '6px' }}>Total Expenses</div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          {activeSeries.map((s, idx) => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <div style={{ width: '14px', height: '2.5px', background: CAT_COLORS[idx % CAT_COLORS.length], borderRadius: '2px' }} />
              <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--gray-500)' }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ position: 'relative' }}>
        {hoverIdx !== null && (
          <div style={{
            position: 'absolute', top: '2px', zIndex: 20, pointerEvents: 'none',
            left: `clamp(60px, ${tipPct}%, calc(100% - 60px))`,
            transform: 'translateX(-50%)',
            background: '#1e293b', color: '#fff',
            fontSize: '9.5px', fontWeight: 600,
            padding: '8px 12px', borderRadius: '10px',
            lineHeight: 1.9, whiteSpace: 'nowrap',
            boxShadow: '0 4px 20px rgba(0,0,0,.35)',
            border: '1px solid rgba(255,255,255,.08)',
          }}>
            <div style={{ fontSize: '9px', color: '#94a3b8', fontWeight: 500, marginBottom: '3px' }}>{labels[hoverIdx]}</div>
            {activeSeries.map((s, idx) => (
              <div key={s.label} style={{ color: CAT_COLORS[idx % CAT_COLORS.length] }}>
                ● {s.label}: ${(s.data[hoverIdx] || 0).toLocaleString('en-AU')}
              </div>
            ))}
          </div>
        )}

        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="180"
          preserveAspectRatio="none"
          style={{ display: 'block', cursor: 'crosshair', overflow: 'hidden' }}
          onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}
        >
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PL} y1={t.y} x2={W - PR} y2={t.y} stroke={i === 0 ? '#e2e8f0' : '#f1f5f9'} strokeWidth="0.8" />
              <text x={PL + 4} y={t.y - 3} textAnchor="start" fontSize="8" fontWeight="500" fill="#94a3b8">{t.label}</text>
            </g>
          ))}

          {activeSeries.map((s, idx) => (
            <path
              key={s.label}
              d={smoothPath(s.data.map((v, i) => [xOf(i), yOf(v)]))}
              fill="none"
              stroke={CAT_COLORS[idx % CAT_COLORS.length]}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}

          {labels.map((lbl, i) => i % labelEvery === 0 ? (
            <text key={i} x={xOf(i).toFixed(1)} y={H - 5}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize="7.5" fill="#94a3b8"
            >{lbl}</text>
          ) : null)}

          {hX !== null && (
            <>
              <line x1={hX} y1={PT} x2={hX} y2={floorY} stroke="#cbd5e1" strokeWidth="1" strokeDasharray="3,3" />
              {activeSeries.map((s, idx) => (
                <circle key={s.label} cx={hX} cy={yOf(s.data[hoverIdx] || 0)} r="3" fill="#fff" stroke={CAT_COLORS[idx % CAT_COLORS.length]} strokeWidth="1.5" />
              ))}
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

// ── Finance area chart ────────────────────────────────────────────────────────
const FC = {
  inc:  { stroke: '#2563eb', label: 'Income',   dot: '#93c5fd' },
  exp:  { stroke: '#f43f5e', label: 'Expenses', dot: '#fda4af' },
  prof: { stroke: '#15803d', label: 'Profit',   dot: '#4ade80' },
};

// Straight-line path (no spline overshoot — accurate for spiky daily data).
function linePath(pts) {
  if (!pts || !pts.length) return '';
  return 'M' + pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');
}

// Grouped-bar financial chart: Income vs Expenses per time bucket. Profit is
// shown on hover + in the summary tiles. Clear, no overlapping fills.
function FinanceChart({ periods }) {
  const wrapRef = useRef(null);
  const [W, setW] = useState(640);
  const [hoverIdx, setHoverIdx] = useState(null);

  useEffect(() => {
    const el = wrapRef.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(es => { const w = es[0]?.contentRect?.width; if (w) setW(Math.round(w)); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const INC = '#16a34a', EXP = '#ef4444';
  const narrow = W < 480;
  const H = narrow ? 200 : 240;
  const PL = 42, PR = 12, PT = 12, PB = 28;
  const cW = Math.max(1, W - PL - PR), cH = H - PT - PB;
  const floorY = PT + cH;

  const n = periods.length || 1;
  const allVals = periods.flatMap(p => [p.income, p.exp]);
  const rawMax = Math.max(...allVals, 1);
  const niceStep = (() => {
    const rough = rawMax / 4;
    const e = Math.pow(10, Math.floor(Math.log10(rough)));
    return [1, 2, 2.5, 5, 10].map(s => s * e).find(s => s >= rough) || e * 10;
  })();
  const maxVal = Math.ceil(rawMax / niceStep) * niceStep || 1;
  const hasData = allVals.some(v => v > 0);

  const slot     = cW / n;
  const groupPad = Math.min(slot * 0.28, 18);       // gap between buckets
  const groupW   = Math.max(6, slot - groupPad);
  const barGap   = Math.min(groupW * 0.14, 4);      // gap between the 2 bars in a group
  const barW     = Math.max(3, (groupW - barGap) / 2);
  const yOf      = v => PT + cH - (v / maxVal) * cH;
  const xSlot    = i => PL + i * slot;

  const yTicks = Array.from({ length: 5 }, (_, i) => {
    const v = (maxVal / 4) * i;
    return { v, y: yOf(v), label: v >= 1000 ? `$${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}k` : `$${Math.round(v)}` };
  });

  // x-axis labels: thin them if too many buckets to fit.
  const maxLabels  = Math.max(3, Math.floor(cW / 44));
  const labelEvery = Math.max(1, Math.ceil(n / maxLabels));

  const hP     = hoverIdx !== null ? periods[hoverIdx] : null;
  const tipPct = hoverIdx !== null ? ((xSlot(hoverIdx) + slot / 2) / W * 100) : 50;

  const legend = [{ c: INC, label: 'Income' }, { c: EXP, label: 'Expenses' }];

  return (
    <div style={{ background: '#fff', borderRadius: '16px', padding: '16px 16px 10px', marginBottom: '14px', border: '1px solid var(--gray-200)' }}>
      <div style={{ marginBottom: '10px' }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--gray-800)', marginBottom: '6px' }}>Financial Overview</div>
        <div style={{ display: 'flex', gap: '14px' }}>
          {legend.map(s => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <div style={{ width: '11px', height: '11px', background: s.c, borderRadius: '3px' }} />
              <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--gray-500)' }}>{s.label}</span>
            </div>
          ))}
        </div>
        {!hasData && <div style={{ fontSize: '10px', color: 'var(--gray-400)', marginTop: '4px' }}>No data — add revenue or expenses</div>}
      </div>

      <div ref={wrapRef} style={{ position: 'relative' }}>
        {hoverIdx !== null && hP && (
          <div style={{
            position: 'absolute', top: '2px', zIndex: 20, pointerEvents: 'none',
            left: `clamp(78px, ${tipPct}%, calc(100% - 78px))`,
            transform: 'translateX(-50%)',
            background: '#1e293b', color: '#fff', fontSize: '10px', fontWeight: 600,
            padding: '8px 12px', borderRadius: '10px', lineHeight: 1.8, whiteSpace: 'nowrap',
            boxShadow: '0 4px 20px rgba(0,0,0,.35)', border: '1px solid rgba(255,255,255,.08)',
          }}>
            <div style={{ fontSize: '9px', color: '#94a3b8', fontWeight: 500, marginBottom: '3px' }}>{hP.label}</div>
            <div style={{ color: '#4ade80' }}>● Income: ${hP.income.toLocaleString('en-AU')}</div>
            <div style={{ color: '#fca5a5' }}>● Expenses: ${hP.exp.toLocaleString('en-AU')}</div>
            <div style={{ color: (hP.income - hP.exp) >= 0 ? '#7dd3fc' : '#fda4af' }}>● Profit: ${(hP.income - hP.exp).toLocaleString('en-AU')}</div>
          </div>
        )}

        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: 'block', overflow: 'visible' }}>
          {/* Grid + Y labels */}
          {yTicks.map((t, i) => (
            <g key={i}>
              <line x1={PL} y1={t.y} x2={W - PR} y2={t.y} stroke={i === 0 ? '#e2e8f0' : '#f1f5f9'} strokeWidth="1" />
              <text x={PL - 6} y={t.y + 3.5} textAnchor="end" fontSize="10.5" fontWeight="500" fill="#94a3b8">{t.label}</text>
            </g>
          ))}

          {/* Bars */}
          {periods.map((p, i) => {
            const gx = xSlot(i) + groupPad / 2;
            const incH = Math.max(p.income > 0 ? 2 : 0, floorY - yOf(p.income));
            const expH = Math.max(p.exp > 0 ? 2 : 0, floorY - yOf(p.exp));
            const rx = Math.min(3, barW / 2);
            const dim = hoverIdx !== null && hoverIdx !== i ? 0.42 : 1;
            return (
              <g key={i} style={{ opacity: dim, transition: 'opacity .12s' }}>
                {hoverIdx === i && <rect x={xSlot(i)} y={PT} width={slot} height={cH} fill="#f8fafc" />}
                <rect x={gx} y={floorY - incH} width={barW} height={incH} rx={rx} fill={INC} />
                <rect x={gx + barW + barGap} y={floorY - expH} width={barW} height={expH} rx={rx} fill={EXP} />
              </g>
            );
          })}

          {/* X labels */}
          {periods.map((p, i) => i % labelEvery === 0 ? (
            <text key={i} x={xSlot(i) + slot / 2} y={H - 8} textAnchor="middle" fontSize="10.5" fill="#94a3b8">{p.label}</text>
          ) : null)}

          {/* Hover hit-areas (one per bucket) */}
          {periods.map((p, i) => (
            <rect key={i} x={xSlot(i)} y={PT} width={slot} height={cH} fill="transparent"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoverIdx(i)} onMouseLeave={() => setHoverIdx(null)} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function Bar({ label, value, max, color, bg, count }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--gray-700)' }}>{label}</span>
          {count !== undefined && <span style={{ fontSize: '10px', color: 'var(--gray-400)', fontWeight: 500 }}>{count} job{count !== 1 ? 's' : ''}</span>}
        </div>
        <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--gray-900)' }}>
          ${value.toLocaleString('en-AU', { minimumFractionDigits: 0 })}
        </span>
      </div>
      <div style={{ height: '8px', background: '#f1f5f9', borderRadius: '4px', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: '4px', transition: 'width .35s ease' }} />
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const { leads } = useLeadsContext();
  const [range,       setRange]       = useState('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd,   setCustomEnd]   = useState('');
  const [activeTab,      setActiveTab]      = useState('overview'); // 'overview' | 'source' | 'transactions'
  const [selectedSource, setSelectedSource] = useState(null); // null = all sources
  const [expCategory,    setExpCategory]    = useState('all');       // Expenses tab: category filter
  const [expSort,        setExpSort]        = useState('date-desc');  // Expenses tab: sort order

  const [expenses,       setExpenses]       = useState([]);
  const [revenueRecords, setRevenueRecords] = useState([]);
  const [isLoading,      setIsLoading]      = useState(true);

  useEffect(() => {
    Promise.all([
      fetchRecords(AT_TABLES.expenses),
      fetchRecords(AT_TABLES.revenue),
    ]).then(([expRecs, revRecs]) => {
      setExpenses(expRecs.map(r => ({
        id:          r.id,
        name:        r.fields['Expense Name'] || '',
        category:    r.fields['Category']    || 'General',
        amount:      parseFloat(r.fields['Amount'] || 0),
        description: r.fields['Description'] || '',
        date:        r.fields['Date']        || '',
      })));
      setRevenueRecords(revRecs.map(r => ({
        id:      r.id,
        name:    r.fields['Revenue Name']   || r.fields['Client Name'] || '',
        client:  r.fields['Client Name']   || '',
        phone:   r.fields['Phone']          || '',
        jobType: r.fields['Job_Service']    || '',
        city:    r.fields['City']           || '',
        method:  r.fields['Payment_Method'] || '',
        amount:  parseFloat(r.fields['Amount'] || 0),
        date:    r.fields['Date']           || '',
        status:  r.fields['Status']         || '',
      })));
    }).finally(() => setIsLoading(false));
  }, []);

  // Build phone → leadSource lookup from leads
  const sourceByPhone = useMemo(() => {
    const map = {};
    leads.forEach(l => {
      if (!l.phone) return;
      const key = l.phone.replace(/\s/g, '').toLowerCase();
      if (!map[key]) {
        map[key] = l.leadSource || (l.hasCall ? 'Phone Call' : 'Other');
      }
    });
    return map;
  }, [leads]);

  const { from, to } = useMemo(() => {
    if (range === 'custom') {
      return {
        from: customStart ? new Date(customStart) : null,
        to:   customEnd   ? new Date(customEnd + 'T23:59:59') : null,
      };
    }
    return { from: startOf(range), to: new Date() };
  }, [range, customStart, customEnd]);

  function inRange(dateVal) {
    if (!from && !to) return true;
    const d = new Date(dateVal);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  }

  const filteredRevenue = revenueRecords
    .filter(r => inRange(r.date) && (r.status === 'Job Done' || r.status === ''))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const filteredExpenses = expenses.filter(e => inRange(e.date));
  const chartPeriods = useMemo(
    () => buildPeriods(range, from, to, filteredRevenue, filteredExpenses),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, from?.getTime(), to?.getTime(), revenueRecords, expenses]
  );

  // Separate upsell records from regular job revenue
  const isUpsellRecord = r => (r.name || '').toLowerCase().includes('upsell') || r.jobType === 'Upsell';
  const mainRevenue   = filteredRevenue.filter(r => !isUpsellRecord(r));
  const upsellRevenue = filteredRevenue.filter(r =>  isUpsellRecord(r));
  const totalUpsell   = upsellRevenue.reduce((s, r) => s + r.amount, 0);

  const totalIncome   = filteredRevenue.reduce((s, r) => s + r.amount, 0);
  const totalExpenses = filteredExpenses.reduce((s, e) => s + e.amount, 0);
  const profit        = totalIncome - totalExpenses;

  // Revenue enriched with source (matched by phone)
  const revenueWithSource = filteredRevenue.map(r => ({
    ...r,
    source: sourceByPhone[r.phone?.replace(/\s/g, '').toLowerCase()] || 'Other',
  }));

  // Group by source
  const bySource = {};
  revenueWithSource.forEach(r => {
    const k = r.source;
    if (!bySource[k]) bySource[k] = { amount: 0, count: 0 };
    bySource[k].amount += r.amount;
    bySource[k].count  += 1;
  });

  // Group by job type (exclude upsell records — tracked separately)
  const byJobType = {};
  mainRevenue.forEach(r => {
    const k = r.jobType || 'Other';
    if (!byJobType[k]) byJobType[k] = { amount: 0, count: 0 };
    byJobType[k].amount += r.amount;
    byJobType[k].count  += 1;
  });

  // Group expenses by category
  const byCategory = {};
  filteredExpenses.forEach(e => {
    byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  });

  const maxSource  = Math.max(...Object.values(bySource).map(v => v.amount),  1);
  const maxJobType = Math.max(...Object.values(byJobType).map(v => v.amount), 1);
  const maxCat     = Math.max(...Object.values(byCategory), 1);

  // Expenses tab: category filter + sort + group (period already handled by `range`)
  const expCategories = [...new Set(filteredExpenses.map(e => e.category))].filter(Boolean).sort();
  const sortExp = (a, b) => {
    if (expSort === 'date-asc')   return new Date(a.date) - new Date(b.date);
    if (expSort === 'amount-desc') return b.amount - a.amount;
    if (expSort === 'amount-asc')  return a.amount - b.amount;
    return new Date(b.date) - new Date(a.date); // date-desc (default)
  };
  const visibleExpenses = filteredExpenses.filter(e => expCategory === 'all' || e.category === expCategory);
  const expenseGroups = Object.entries(
    visibleExpenses.reduce((acc, e) => { (acc[e.category] = acc[e.category] || []).push(e); return acc; }, {})
  ).map(([cat, items]) => ({ cat, items: [...items].sort(sortExp), total: items.reduce((s, e) => s + e.amount, 0) }))
   .sort((a, b) => b.total - a.total);

  const outstandingLeads = leads.filter(l => l.status === 'job_done' && !l.paid && inRange(l.date));
  const jobDoneLeads     = leads.filter(l => l.status === 'job_done' && inRange(l.date))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const rangeLabel = RANGES.find(r => r.id === range)?.label || '';

  if (isLoading) {
    return (
      <div className="page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px' }}>
        <div style={{ color: 'var(--gray-400)', fontSize: '14px' }}>Loading reports…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '17px', fontWeight: 700, color: 'var(--gray-900)' }}>Reports</div>
        <div style={{ fontSize: '13px', color: 'var(--gray-500)', marginTop: '2px' }}>Income, expenses & lead sources</div>
      </div>

      {/* ── Area chart ── */}
      <FinanceChart periods={chartPeriods} />

      {/* ── Summary cards ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
        <SummaryCard
          label="Income"
          value={totalIncome}
          count={`${mainRevenue.length} job${mainRevenue.length !== 1 ? 's' : ''}${totalUpsell > 0 ? ` + $${totalUpsell.toLocaleString()} upsell` : ''}`}
          color="#15803d" bg="#f0fdf4" border="#bbf7d0"
        />
        <SummaryCard label="Expenses" value={totalExpenses} count={`${filteredExpenses.length} items`} color="#dc2626" bg="#fef2f2" border="#fecaca" />
        <SummaryCard
          label="Profit"
          value={Math.abs(profit)}
          prefix={profit < 0 ? '-' : ''}
          count={profit >= 0 ? 'net gain' : 'net loss'}
          color={profit >= 0 ? '#15803d' : '#dc2626'}
          bg={profit >= 0 ? '#f0fdf4' : '#fef2f2'}
          border={profit >= 0 ? '#bbf7d0' : '#fecaca'}
        />
      </div>

      {/* ── Tab bar ── */}
      <div style={{ display: 'flex', gap: '4px', background: '#f1f5f9', borderRadius: '10px', padding: '4px', marginBottom: '10px' }}>
        {[
          { id: 'overview',      label: 'Overview' },
          { id: 'expenses',      label: 'Expenses' },
          { id: 'source',        label: 'By Source' },
          { id: 'transactions',  label: 'Transactions' },
        ].map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)} style={{
            flex: 1, padding: '8px 4px', borderRadius: '7px', fontSize: '12px', fontWeight: 700,
            cursor: 'pointer', fontFamily: 'inherit', border: 'none',
            background: activeTab === t.id ? '#fff' : 'transparent',
            color: activeTab === t.id ? 'var(--gray-900)' : 'var(--gray-500)',
            boxShadow: activeTab === t.id ? '0 1px 4px rgba(0,0,0,0.10)' : 'none',
            transition: 'all .15s',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Range selector (below tabs, always visible) ── */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', flexWrap: 'wrap' }}>
        {RANGES.map(r => (
          <button key={r.id} onClick={() => setRange(r.id)} style={{
            padding: '6px 14px', borderRadius: '20px', fontSize: '12px', fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap', flexShrink: 0,
            border: `1.5px solid ${range === r.id ? 'var(--primary)' : 'var(--gray-200)'}`,
            background: range === r.id ? 'var(--primary)' : '#fff',
            color: range === r.id ? '#fff' : 'var(--gray-600)',
          }}>
            {r.label}
          </button>
        ))}
      </div>
      {range === 'custom' && (
        <div style={{ background: '#fff', border: '1px solid var(--gray-200)', borderRadius: '10px', padding: '12px 14px', marginBottom: '14px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div>
              <label style={lbl}>From</label>
              <input
                type="date"
                value={customStart}
                onChange={e => setCustomStart(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', fontSize: '14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', color: 'var(--gray-800)', background: '#f9fafb' }}
              />
            </div>
            <div>
              <label style={lbl}>To</label>
              <input
                type="date"
                value={customEnd}
                onChange={e => setCustomEnd(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', fontSize: '14px', border: '1.5px solid var(--gray-200)', borderRadius: '8px', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', color: 'var(--gray-800)', background: '#f9fafb' }}
              />
            </div>
          </div>
          {customStart && customEnd && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: 'var(--gray-500)', textAlign: 'center' }}>
              Showing {new Date(customStart).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} – {new Date(customEnd).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
            </div>
          )}
        </div>
      )}

      {/* ── Overview tab ── */}
      {activeTab === 'overview' && (
        <>
          {Object.keys(byJobType).length > 0 && (
            <div style={card}>
              <div style={cardHdr}>Income by Job Type</div>
              {Object.entries(byJobType).sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => (
                <Bar key={k} label={k} value={v.amount} max={maxJobType} color="#16a34a" bg="#f0fdf4" count={v.count} />
              ))}
            </div>
          )}

          {totalUpsell > 0 && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <div>
                  <div style={cardHdr2}>Upsell Income</div>
                  <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>Extra services added on top of jobs</div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, background: '#fffbeb', color: '#92400e', borderRadius: '20px', padding: '3px 10px', border: '1px solid #fde68a' }}>
                  {upsellRevenue.length} upsell{upsellRevenue.length !== 1 ? 's' : ''}
                </span>
              </div>
              {upsellRevenue.map(r => {
                const desc = ((r.name || '').split('Upsell: ')[1] || '').trim();
                return (
                  <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--gray-100)' }}>
                    <div>
                      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>
                        {r.client || r.name}
                        {desc && <span style={{ fontWeight: 400, color: '#92400e', fontSize: '12px' }}> · {desc}</span>}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '2px' }}>
                        {new Date(r.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })} · {r.method || 'Cash'}
                      </div>
                    </div>
                    <div style={{ fontWeight: 700, color: '#d97706', fontSize: '14px' }}>+${r.amount.toLocaleString('en-AU')}</div>
                  </div>
                );
              })}
              <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: '10px', borderTop: '2px solid #fde68a', marginTop: '4px' }}>
                <span style={{ fontSize: '14px', fontWeight: 800, color: '#92400e' }}>
                  Total: ${totalUpsell.toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}


          {outstandingLeads.length > 0 && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <div>
                  <div style={cardHdr2}>Awaiting Payment</div>
                  <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>Job done — payment not yet collected</div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, background: '#fff7ed', color: '#c2410c', borderRadius: '20px', padding: '3px 10px' }}>{outstandingLeads.length} unpaid</span>
              </div>
              {outstandingLeads.map(l => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' }}>
                  <div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>{l.name}</div>
                    <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '2px' }}>{l.phone || '—'} · {l.jobType || 'No job type'}</div>
                  </div>
                  <div style={{ fontWeight: 700, color: '#c2410c', fontSize: '14px' }}>
                    {l.value > 0 ? `$${l.value.toLocaleString('en-AU')}` : '—'}
                  </div>
                </div>
              ))}
            </div>
          )}

          {filteredRevenue.length === 0 && filteredExpenses.length === 0 && (
            <EmptyState />
          )}
        </>
      )}

      {/* ── Expenses tab ── */}
      {activeTab === 'expenses' && (
        <>
          {filteredExpenses.length > 0 ? (
            <>
              {/* Filter + sort controls (period handled by the range selector above) */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '12px', flexWrap: 'wrap' }}>
                <select value={expCategory} onChange={e => setExpCategory(e.target.value)} style={expSelect}>
                  <option value="all">All categories</option>
                  {expCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <select value={expSort} onChange={e => setExpSort(e.target.value)} style={expSelect}>
                  <option value="date-desc">Date — newest first</option>
                  <option value="date-asc">Date — oldest first</option>
                  <option value="amount-desc">Amount — high to low</option>
                  <option value="amount-asc">Amount — low to high</option>
                </select>
              </div>

              {/* Category summary bars */}
              <div style={card}>
                <div style={cardHdr}>Expenses by Category{expCategory !== 'all' ? ` — ${expCategory}` : ''}</div>
                {expenseGroups.map(g => (
                  <Bar key={g.cat} label={g.cat} value={g.total} max={maxCat} color="#dc2626" bg="#fef2f2" count={g.items.length} />
                ))}
              </div>

              {/* Itemised list, grouped by category, sorted */}
              <div style={card}>
                <div style={cardHdr}>Expense Items · {visibleExpenses.length}</div>
                {expenseGroups.map(g => (
                  <div key={g.cat} style={{ marginBottom: '14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--gray-100)', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--gray-700)' }}>{g.cat}</span>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#dc2626' }}>${g.total.toLocaleString('en-AU')}</span>
                    </div>
                    {g.items.map(it => (
                      <div key={it.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0', gap: '10px' }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '13px', color: 'var(--gray-800)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name || it.description || it.category}</div>
                          <div style={{ fontSize: '11px', color: 'var(--gray-400)' }}>{it.date ? new Date(it.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</div>
                        </div>
                        <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-800)', flexShrink: 0 }}>${it.amount.toLocaleString('en-AU')}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyState msg="No expenses recorded for this period." />
          )}
        </>
      )}

      {/* ── By Source tab ── */}
      {activeTab === 'source' && (
        <>
          {Object.keys(bySource).length > 0 ? (
            <>
              {/* Clickable source cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px', marginBottom: '14px' }}>
                {Object.entries(bySource).sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => {
                  const meta    = getSourceMeta(k);
                  const pct     = totalIncome > 0 ? Math.round((v.amount / totalIncome) * 100) : 0;
                  const isActive = selectedSource === k;
                  return (
                    <div
                      key={k}
                      onClick={() => setSelectedSource(isActive ? null : k)}
                      style={{
                        background: isActive ? meta.color : meta.bg,
                        border: `2px solid ${isActive ? meta.color : `${meta.color}33`}`,
                        borderRadius: '12px', padding: '14px 12px', cursor: 'pointer',
                        transition: 'all .15s',
                      }}
                    >
                      <div style={{ fontSize: '10px', fontWeight: 700, color: isActive ? 'rgba(255,255,255,0.8)' : meta.color, textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: '5px' }}>
                        {meta.label}
                      </div>
                      <div style={{ fontSize: '19px', fontWeight: 800, color: isActive ? '#fff' : 'var(--gray-900)' }}>
                        ${v.amount.toLocaleString('en-AU')}
                      </div>
                      <div style={{ fontSize: '11px', color: isActive ? 'rgba(255,255,255,0.75)' : 'var(--gray-500)', marginTop: '3px' }}>
                        {v.count} job{v.count !== 1 ? 's' : ''} · {pct}%
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Bar chart */}
              <div style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                  <div style={cardHdr2}>
                    {selectedSource ? `${getSourceMeta(selectedSource).label} — Transactions` : 'All Sources'}
                  </div>
                  {selectedSource && (
                    <button onClick={() => setSelectedSource(null)} style={{ fontSize: '11px', color: 'var(--gray-400)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                      Clear ✕
                    </button>
                  )}
                </div>

                {/* Bars — filtered or all */}
                {!selectedSource && Object.entries(bySource).sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => {
                  const meta = getSourceMeta(k);
                  return <Bar key={k} label={meta.label} value={v.amount} max={maxSource} color={meta.color} bg={meta.bg} count={v.count} />;
                })}

                {/* Transaction list for selected source */}
                {revenueWithSource
                  .filter(r => !selectedSource || r.source === selectedSource)
                  .map(row => {
                    const sm = getSourceMeta(row.source);
                    const isUpsell = isUpsellRecord(row);
                    const upsellDesc = isUpsell ? ((row.name || '').split('Upsell: ')[1] || '').trim() : '';
                    return (
                      <div key={row.id} style={{ padding: '10px 0', borderTop: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>{row.client || row.name}</span>
                            {isUpsell && <span style={{ fontSize: '9px', fontWeight: 700, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', padding: '1px 5px', borderRadius: '6px' }}>UPSELL</span>}
                            {isUpsell && upsellDesc && <span style={{ fontSize: '11px', color: '#92400e' }}>{upsellDesc}</span>}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '2px' }}>
                            {new Date(row.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}
                            {!isUpsell && row.jobType ? ` · ${row.jobType}` : ''}
                            {row.method ? ` · ${row.method}` : ''}
                          </div>
                        </div>
                        <span style={{ fontWeight: 700, color: '#15803d', fontSize: '14px', flexShrink: 0 }}>
                          ${Number(row.amount).toLocaleString('en-AU')}
                        </span>
                      </div>
                    );
                  })
                }
              </div>
            </>
          ) : (
            <EmptyState msg="No revenue data with source information for this period." />
          )}
        </>
      )}

      {/* ── Transactions tab ── */}
      {activeTab === 'transactions' && (
        <>
          {/* Job Done Leads from Kanban */}
          {jobDoneLeads.length > 0 && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <div>
                  <div style={cardHdr2}>Job Done Leads</div>
                  <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' }}>All completed jobs from the pipeline</div>
                </div>
                <span style={{ fontSize: '11px', fontWeight: 700, background: '#f0fdf4', color: '#15803d', borderRadius: '20px', padding: '3px 10px', border: '1px solid #bbf7d0' }}>
                  {jobDoneLeads.length} job{jobDoneLeads.length !== 1 ? 's' : ''}
                </span>
              </div>
              {jobDoneLeads.map((l, i) => {
                const src = l.leadSource || (l.hasCall ? 'Phone Call' : 'Other');
                const sm  = getSourceMeta(src);
                return (
                  <div key={l.id} style={{ padding: '11px 0', borderBottom: i < jobDoneLeads.length - 1 ? '1px solid var(--gray-100)' : 'none', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>{l.name}</span>
                        <span style={{ fontSize: '9px', fontWeight: 700, background: sm.bg, color: sm.color, padding: '1px 5px', borderRadius: '6px' }}>{sm.label.toUpperCase()}</span>
                        {l.paid && <span style={{ fontSize: '9px', fontWeight: 700, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', padding: '1px 5px', borderRadius: '6px' }}>PAID</span>}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '3px' }}>
                        {new Date(l.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {l.jobType ? ` · ${l.jobType}` : ''}
                        {l.phone ? ` · ${l.phone}` : ''}
                      </div>
                    </div>
                    <div style={{ fontWeight: 800, color: l.value > 0 ? '#15803d' : 'var(--gray-400)', fontSize: '15px', flexShrink: 0 }}>
                      {l.value > 0 ? `$${l.value.toLocaleString('en-AU', { minimumFractionDigits: 2 })}` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {filteredRevenue.length > 0 ? (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                <div style={cardHdr2}>Revenue Transactions</div>
                <span style={{ fontSize: '11px', fontWeight: 700, background: '#f0fdf4', color: '#15803d', borderRadius: '20px', padding: '3px 10px' }}>
                  {filteredRevenue.length} record{filteredRevenue.length !== 1 ? 's' : ''}
                </span>
              </div>
              {filteredRevenue.map(row => {
                const src = sourceByPhone[row.phone?.replace(/\s/g, '').toLowerCase()] || '';
                const sm  = src ? getSourceMeta(src) : null;
                const isUpsell = isUpsellRecord(row);
                const upsellDesc = isUpsell ? ((row.name || '').split('Upsell: ')[1] || '').trim() : '';
                return (
                  <div key={row.id} style={{ padding: '11px 0', borderBottom: '1px solid var(--gray-100)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-900)' }}>{row.client || row.name}</span>
                        {isUpsell && <span style={{ fontSize: '9px', fontWeight: 700, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', padding: '1px 5px', borderRadius: '6px' }}>UPSELL</span>}
                        {isUpsell && upsellDesc && <span style={{ fontSize: '11px', color: '#92400e' }}>{upsellDesc}</span>}
                        {sm && <span style={{ fontSize: '9px', fontWeight: 700, background: sm.bg, color: sm.color, padding: '1px 5px', borderRadius: '6px' }}>{sm.label.toUpperCase()}</span>}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--gray-500)', marginTop: '3px' }}>
                        {new Date(row.date).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                        {!isUpsell && row.jobType ? ` · ${row.jobType}` : ''}
                        {row.city ? ` · ${row.city}` : ''}
                      </div>
                      {row.method && (
                        <span style={{ display: 'inline-block', marginTop: '4px', fontSize: '10px', fontWeight: 700, padding: '1px 8px', borderRadius: '20px', background: row.method === 'Cash' ? '#f0fdf4' : '#eff6ff', color: row.method === 'Cash' ? '#15803d' : '#2563eb', border: `1px solid ${row.method === 'Cash' ? '#bbf7d0' : '#bfdbfe'}` }}>
                          {row.method.toUpperCase()}
                        </span>
                      )}
                    </div>
                    <div style={{ fontWeight: 800, color: '#15803d', fontSize: '15px', flexShrink: 0 }}>
                      ${Number(row.amount).toLocaleString('en-AU', { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {jobDoneLeads.length === 0 && filteredRevenue.length === 0 && <EmptyState />}
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, prefix = '', count, color, bg, border }) {
  return (
    <div style={{ background: bg, border: `1.5px solid ${border}`, borderRadius: '12px', padding: '14px 12px' }}>
      <div style={{ fontSize: '10px', fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: 800, color, marginTop: '5px', lineHeight: 1.1 }}>
        {prefix}${value.toLocaleString('en-AU', { minimumFractionDigits: 0 })}
      </div>
      <div style={{ fontSize: '10px', color, opacity: 0.75, marginTop: '3px' }}>{count}</div>
    </div>
  );
}

function EmptyState({ msg }) {
  return (
    <div style={{ background: '#fff', borderRadius: '12px', border: '1px solid var(--gray-200)', padding: '48px 20px', textAlign: 'center' }}>
      <svg fill="none" viewBox="0 0 24 24" stroke="var(--gray-300)" strokeWidth="1.5" style={{ width: '40px', height: '40px', margin: '0 auto 10px', display: 'block' }}>
        <path d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
      </svg>
      <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--gray-500)' }}>No data for this period</div>
      <div style={{ fontSize: '12px', color: 'var(--gray-400)', marginTop: '5px' }}>{msg || 'Mark leads as paid and add expenses to see reports here'}</div>
    </div>
  );
}

const card     = { background: '#fff', borderRadius: '12px', border: '1px solid var(--gray-200)', padding: '18px 16px', marginBottom: '14px' };
const cardHdr  = { fontSize: '14px', fontWeight: 700, color: 'var(--gray-900)', marginBottom: '16px' };
const cardHdr2 = { fontSize: '14px', fontWeight: 700, color: 'var(--gray-900)' };
const lbl      = { fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--gray-500)', marginBottom: '5px', display: 'block' };
const expSelect = { flex: '1 1 160px', minWidth: 0, padding: '9px 12px', fontSize: '13px', fontWeight: 600, color: 'var(--gray-700)', border: '1.5px solid var(--gray-200)', borderRadius: '8px', background: '#fff', fontFamily: 'inherit', cursor: 'pointer', outline: 'none' };
