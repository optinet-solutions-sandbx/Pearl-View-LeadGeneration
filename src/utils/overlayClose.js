// Shared "click outside to close" guard for modal/panel overlays.
//
// The naive `onClick={e => e.target === e.currentTarget && close()}` closes the
// modal whenever a click LANDS on the backdrop. But a text-selection DRAG also
// ends in a `click` on the backdrop, so the modal wrongly closes mid-highlight
// (and, in the job-done flow, silently finalises the job). This happens whether
// the drag starts inside the modal and ends on the backdrop, OR starts on the
// backdrop and sweeps across the modal selecting everything.
//
// Fix: only close on a GENUINE click — the pointer pressed AND released on the
// backdrop itself, and barely moved in between. A drag (text selection) moves
// far, so we ignore it. A real click-to-dismiss barely moves, so it still works.
//
// Module-level state is safe: only one overlay can be dragged at a time.
let _downOnOverlay = false;
let _downX = 0;
let _downY = 0;

// Pixels the pointer may travel between press and release and still count as a
// "click" rather than a drag. Small enough to reject selections, large enough to
// tolerate a shaky hand / trackpad.
const CLICK_SLOP = 8;

// overlayClose(onClose) → spread the result onto the backdrop element:
//   <div style={overlay} {...overlayClose(onClose)}>
// Pass a guarded callback when the modal is busy, e.g. () => { if (!busy) close(); }.
export function overlayClose(onClose) {
  return {
    onMouseDown: e => {
      _downOnOverlay = e.target === e.currentTarget;
      _downX = e.clientX;
      _downY = e.clientY;
    },
    onClick: e => {
      if (e.target !== e.currentTarget || !_downOnOverlay) return;
      // A text-selection drag ends far from where it began → not a dismiss click.
      if (Math.abs(e.clientX - _downX) + Math.abs(e.clientY - _downY) > CLICK_SLOP) return;
      onClose();
    },
  };
}
