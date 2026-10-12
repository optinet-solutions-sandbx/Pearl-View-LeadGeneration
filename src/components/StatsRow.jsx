import { useRef, useEffect } from 'react';
import { useLeadsContext } from '../context/LeadsContext';

// ── Animated donut ring ────────────────────────────────────────────────────────
function DonutRing({ pct, color, size = 46 }) {
  const circleRef = useRef(null);
  const r    = (size - 7) / 2;
  const circ = 2 * Math.PI * r;
  const target = circ * (1 - Math.min(Math.max(pct, 0), 100) / 100);

  useEffect(() => {
    const el = circleRef.current;
    if (!el) return;
    el.style.strokeDasharray  = circ;
    el.style.strokeDashoffset = circ;          // start hidden
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (el) {
          el.style.transition       = 'stroke-dashoffset 1s ease';
          el.style.strokeDashoffset = target;  // animate to target
        }
      })
    );
    return () => cancelAnimationFrame(raf);
  }, [pct]);

  return (
    <svg width={size} height={size} style={{ flexShrink: 0 }}>
      {/* Track */}
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke={color} strokeOpacity="0.15" strokeWidth="4.5"
      />
      {/* Progress arc */}
      <circle
        ref={circleRef}
        cx={size / 2} cy={size / 2} r={r}
        fill="none" stroke={color} strokeWidth="4.5" strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ strokeDasharray: circ, strokeDashoffset: circ }}
      />
      {/* Centre label */}
      <text
        x={size / 2} y={size / 2}
        textAnchor="middle" dominantBaseline="central"
        fontSize="9.5" fontWeight="800" fill={color}
      >
        {Math.round(pct)}%
      </text>
    </svg>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, color, pct, onClick, isActive }) {
  return (
    <div
      className={`stat-card stat-clickable${isActive ? ' stat-active' : ''}`}
      onClick={onClick}
    >
      <div className="stat-top">
        <span className="stat-lbl" style={{ color }}>{label}</span>
        <DonutRing pct={pct} color={color} />
      </div>
      <div className="stat-val">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

// ── StatsRow ──────────────────────────────────────────────────────────────────
export default function StatsRow() {
  const { leads, statFilter, toggleStatFilter } = useLeadsContext();

  const total        = leads.length || 1; // avoid /0
  const newCount     = leads.filter(l => l.status === 'new').length;
  const callCount    = leads.filter(l => l.hasCall).length;
  const formCount    = leads.filter(l => !l.hasCall).length;
  const quotedCount  = leads.filter(l => l.status === 'quote_sent').length;
  const refusedLeads = leads.filter(l => l.status === 'refused');

  // Refuse reason breakdown subtitle
  const rc = { too_expensive: 0, competition: 0, no_answer: 0, no_response: 0, other: 0 };
  refusedLeads.forEach(l => { if (l.refuseReason && rc[l.refuseReason] !== undefined) rc[l.refuseReason]++; });
  const refuseParts = [];
  if (rc.too_expensive) refuseParts.push(`${rc.too_expensive} expensive`);
  if (rc.competition)   refuseParts.push(`${rc.competition} competition`);
  if (rc.no_answer)     refuseParts.push(`${rc.no_answer} no answer`);
  if (rc.no_response)   refuseParts.push(`${rc.no_response} no response`);
  if (rc.other)         refuseParts.push(`${rc.other} other`);
  const refusedSub = refuseParts.length ? refuseParts.join(' · ') : 'Declined leads';

  return (
    <div className="stats">
      <StatCard
        label="New Leads"
        value={newCount}
        sub={`${leads.length} total leads`}
        color="#2563eb"
        pct={(newCount / total) * 100}
        isActive={statFilter === 'new'}
        onClick={() => toggleStatFilter('new')}
      />
      <StatCard
        label="Calls Received"
        value={callCount}
        sub={`${formCount} form submissions`}
        color="#16a34a"
        pct={(callCount / total) * 100}
        isActive={statFilter === 'calls'}
        onClick={() => toggleStatFilter('calls')}
      />
      <StatCard
        label="Pending Quotes"
        value={quotedCount}
        sub="Awaiting client response"
        color="#d97706"
        pct={(quotedCount / total) * 100}
        isActive={statFilter === 'quote_sent'}
        onClick={() => toggleStatFilter('quote_sent')}
      />
      <StatCard
        label="Refused"
        value={refusedLeads.length}
        sub={refusedSub}
        color="#dc2626"
        pct={(refusedLeads.length / total) * 100}
        isActive={statFilter === 'refused'}
        onClick={() => toggleStatFilter('refused')}
      />
    </div>
  );
}
