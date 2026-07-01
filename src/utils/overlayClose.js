// Shared "click outside to close" guard for modal/panel overlays.
//
// The naive `onClick={e => e.target === e.currentTarget && close()}` closes the
// modal whenever a click LANDS on the backdrop. But selecting text inside an
// input and releasing the mouse OUTSIDE the modal fires a `click` whose target
// is the backdrop too — so the modal wrongly closes mid-highlight (and, in the
// job-done flow, silently finalises the job).
//
// Fix: only close when the pointer was BOTH pressed and released on the overlay
// itself — i.e. a real click on the backdrop, not a text-drag that ended there.
//
// A single module-level flag is safe: only one overlay can be dragged at a time.
let _downOnOverlay = false;

// overlayClose(onClose) → spread the result onto the backdrop element:
//   <div style={overlay} {...overlayClose(onClose)}>
// Pass a guarded callback when the modal is busy, e.g. () => !busy && close().
export function overlayClose(onClose) {
  return {
    onMouseDown: e => { _downOnOverlay = e.target === e.currentTarget; },
    onClick:     e => { if (e.target === e.currentTarget && _downOnOverlay) onClose(); },
  };
}
