'use strict';

/* Pure zoom maths for the photo viewer.

   There is no DOM in here and no state to keep in sync: every function is a plain
   number-in / number-out transform. The viewer's gestures call them, and the test
   harness calls the same functions with known numbers — which is the only way to
   check "accurate zooming" without a browser in the loop.

   The model
   ---------
   The overlay is VW x VH and its centre is C. At scale 1 the photo is laid out
   W x H, centred on C. A point p of the photo (0..W across, 0..H down) is on screen at

       screen(p) = C + t + s * (p - (W/2, H/2))

   which is exactly what CSS does for `transform: translate(t) scale(s)` with
   `transform-origin: 50% 50%` on an element centred in its parent: the matrix is
   T * S, so the point is scaled about the element's own centre and then translated in
   the parent's *unscaled* coordinates. Keeping the layout and the arithmetic on the
   same formula is what makes a pinch land on the pixel the finger is over.

   The two gestures that need care:
     * zoomAbout   — scale about a fixed screen point (wheel, double-tap, +/-)
     * pinchAbout  — scale about a screen point that is itself moving (two fingers,
                     whose midpoint drifts as they travel)
   Both are exact inverses of screenPoint, so a zoom does not creep: run one and then
   the other with reciprocal scales and you are back where you started.
*/

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZoomMath = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function clampScale(s, min, max) {
    return clamp(s, min, max);
  }

  /* The photo's size at scale 1: as large as it can be with all of it on screen.
     The aspect ratio is preserved exactly (one factor for both axes). */
  function fitSize(nw, nh, VW, VH) {
    if (!(nw > 0) || !(nh > 0) || !(VW > 0) || !(VH > 0)) return { w: 0, h: 0 };
    const f = Math.min(VW / nw, VH / nh);
    return { w: nw * f, h: nh * f };
  }

  /* Where photo point p lands on screen. Used by the gestures and by the tests. */
  function screenPoint(p, center, t, s, W, H) {
    return {
      x: center.x + t.x + s * (p.x - W / 2),
      y: center.y + t.y + s * (p.y - H / 2),
    };
  }

  /* The translate that holds the photo point under `anchor` still while the scale
     goes s0 -> s1. Exact: screen(p) is unchanged for that p. */
  function zoomAbout(anchor, center, t0, s0, s1) {
    const ax = anchor.x - center.x;
    const ay = anchor.y - center.y;
    return { x: ax - (s1 / s0) * (ax - t0.x), y: ay - (s1 / s0) * (ay - t0.y) };
  }

  /* The same, for a pinch: the point under anchor0 before the move ends up under
     anchor1 after it, so the photo follows the fingers instead of drifting. */
  function pinchAbout(anchor0, anchor1, center, t0, s0, s1) {
    const relx = (anchor0.x - center.x - t0.x) / s0;
    const rely = (anchor0.y - center.y - t0.y) / s0;
    return { x: anchor1.x - center.x - s1 * relx, y: anchor1.y - center.y - s1 * rely };
  }

  /* Keep the photo legal: dead centre while it is smaller than the overlay on that
     axis, and never dragged so far that a gap opens at the edge once it is bigger. */
  function clampTranslate(t, s, W, H, VW, VH) {
    const limit = (half, view) => (half <= view / 2 ? 0 : half - view / 2);
    const lx = limit((s * W) / 2, VW);
    const ly = limit((s * H) / 2, VH);
    return { x: clamp(t.x, -lx, lx), y: clamp(t.y, -ly, ly) };
  }

  return { clampScale, fitSize, screenPoint, zoomAbout, pinchAbout, clampTranslate };
});
