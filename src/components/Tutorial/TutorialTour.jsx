import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useLeadsContext } from '../../context/LeadsContext';
import tourSteps from './tourSteps';

export const TUTORIAL_DONE_KEY = 'pvl_tutorial_done';

// ── Interactive spotlight tour ────────────────────────────────────────────────
// Dims the screen, highlights one real UI element at a time and explains it.
// Auto-navigates between pages by driving setCurrentPage. Next-driven — the user
// never needs to click the highlighted element itself.
export default function TutorialTour() {
  const {
    tutorialOpen, stopTutorial,
    currentPage, setCurrentPage,
    sidebarOpen, toggleSidebar,
  } = useLeadsContext();

  const [stepIndex, setStepIndex] = useState(0);
  // rect = highlighted element's viewport box, or null (centered card)
  const [rect, setRect]   = useState(null);
  const [tipPos, setTipPos] = useState({ top: 0, left: 0 });
  // Which step the target has finished measuring for — the tooltip stays hidden
  // until this matches the current step, so it never flashes at a stale spot.
  const [measuredStep, setMeasuredStep] = useState(-1);
  const tipRef = useRef(null);

  const open      = tutorialOpen;
  const step      = tourSteps[stepIndex];
  const isLast    = stepIndex === tourSteps.length - 1;
  const isFirst   = stepIndex === 0;
  // A centered card when the step has no target, or its target couldn't be found.
  const centered  = !rect || step.placement === 'center';

  // Always restart from the beginning each time the tour is opened.
  useEffect(() => {
    if (open) {
      setStepIndex(0);
      setRect(null);
      setMeasuredStep(-1);
    }
  }, [open]);

  function finish() {
    try { localStorage.setItem(TUTORIAL_DONE_KEY, '1'); } catch { /* ignore */ }
    stopTutorial();
  }
  function next() { if (isLast) finish(); else setStepIndex(i => i + 1); }
  function prev() { if (!isFirst) setStepIndex(i => i - 1); }

  // ── Locate + measure the current step's target ──────────────────────────────
  useEffect(() => {
    if (!open) return;
    const s = tourSteps[stepIndex];
    const switchingPage = s.page && s.page !== currentPage;
    if (switchingPage) setCurrentPage(s.page);

    // On mobile the sidebar is off-canvas — open it for nav-targeted steps.
    const isMobile = window.innerWidth <= 768;
    if (isMobile && s.openSidebar && !sidebarOpen) toggleSidebar?.();

    let cancelled = false;
    let tries = 0;

    const tryMeasure = () => {
      if (cancelled) return;
      if (!s.target) { setRect(null); setMeasuredStep(stepIndex); return; }
      const el = document.querySelector(s.target);
      if (el) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
        setTimeout(() => {
          if (cancelled) return;
          const r = el.getBoundingClientRect();
          setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
          setMeasuredStep(stepIndex);
        }, 260);
      } else if (tries < 8) {
        tries++;
        setTimeout(tryMeasure, 90);
      } else {
        setRect(null); // graceful fallback → centered card
        setMeasuredStep(stepIndex);
      }
    };

    const t = setTimeout(tryMeasure, switchingPage ? 260 : 60);
    return () => { cancelled = true; clearTimeout(t); };
    // currentPage/sidebarOpen intentionally omitted — we act on their value at
    // run time and must NOT re-run the effect when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepIndex]);

  // ── Keep the spotlight glued to the element on scroll / resize ──────────────
  useEffect(() => {
    if (!open) return;
    const s = tourSteps[stepIndex];
    if (!s.target) return;
    const reposition = () => {
      const el = document.querySelector(s.target);
      if (el) {
        const r = el.getBoundingClientRect();
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      }
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, stepIndex]);

  // ── Keyboard navigation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepIndex]);

  // ── Position the tooltip once it (and the target) are measured ──────────────
  useLayoutEffect(() => {
    if (!open) return;
    const tip = tipRef.current;
    if (!tip) return;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const M = 12;     // viewport margin
    const gap = 14;   // distance from target

    let top, left;
    if (centered) {
      top  = (vh - th) / 2;
      left = (vw - tw) / 2;
    } else {
      let placement = step.placement;
      if (vw <= 768 && (placement === 'right' || placement === 'left')) placement = 'bottom';
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (placement === 'right')      { left = rect.left + rect.width + gap; top = cy - th / 2; }
      else if (placement === 'left')  { left = rect.left - gap - tw;         top = cy - th / 2; }
      else if (placement === 'top')   { top  = rect.top - gap - th;          left = cx - tw / 2; }
      else                            { top  = rect.top + rect.height + gap;  left = cx - tw / 2; }
    }
    left = Math.max(M, Math.min(left, vw - tw - M));
    top  = Math.max(M, Math.min(top,  vh - th - M));
    setTipPos({ top, left });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepIndex, rect, centered]);

  if (!open) return null;

  const tipReady = measuredStep === stepIndex;
  const PAD = 6; // spotlight padding around the element
  const spotlightStyle = rect ? {
    top:    rect.top - PAD,
    left:   rect.left - PAD,
    width:  rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  } : null;

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="App tutorial">
      {/* Click-catcher: dims the page on centered steps and swallows stray clicks */}
      <div className={`tour-overlay${centered ? ' dim' : ''}`} onClick={() => { /* ignore misclicks */ }} />

      {/* Spotlight cut-out (the big box-shadow darkens everything except the target) */}
      {spotlightStyle && tipReady && <div className="tour-spotlight" style={spotlightStyle} />}

      {/* Tooltip card */}
      <div
        ref={tipRef}
        className="tour-tooltip"
        style={{ top: tipPos.top, left: tipPos.left, visibility: tipReady ? 'visible' : 'hidden' }}
      >
        <div className="tour-counter">Step {stepIndex + 1} of {tourSteps.length}</div>
        <div className="tour-title">{step.title}</div>
        {step.body && <div className="tour-body">{step.body}</div>}

        {step.bullets && step.bullets.length > 0 && (
          <ul className="tour-bullets">
            {step.bullets.map((b, i) => (
              <li key={i}>
                {b.label ? <><span className="tour-bullet-label">{b.label}</span>{b.text ? ` — ${b.text}` : ''}</> : b}
              </li>
            ))}
          </ul>
        )}

        {step.tip && (
          <div className="tour-tip">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7c.6.5 1 1.3 1 2.1h6c0-.8.4-1.6 1-2.1A7 7 0 0012 2z"/>
            </svg>
            <span>{step.tip}</span>
          </div>
        )}

        <div className="tour-dots">
          {tourSteps.map((_, i) => (
            <span key={i} className={`tour-dot${i === stepIndex ? ' active' : ''}`} />
          ))}
        </div>

        <div className="tour-actions">
          <button className="tour-btn tour-btn-ghost" onClick={finish}>Skip</button>
          <div className="tour-actions-right">
            {!isFirst && (
              <button className="tour-btn" onClick={prev}>Back</button>
            )}
            <button className="tour-btn tour-btn-primary" onClick={next}>
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
