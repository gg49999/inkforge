// Render pen strokes into a normalized ink sample. Used by the draw pad's
// offline path, the Node tests, and the demo project.
//
// strokes: [[{x, y, w?}]] in font units (y up, baseline 0), w = pen width in units.

import { UPP } from './constants.js';

export function strokesToSample(char, strokes, { penWidth = 60, id, source = 'synthetic' } = {}) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s) {
    const r = (p.w || penWidth) / 2;
    x0 = Math.min(x0, p.x - r); x1 = Math.max(x1, p.x + r); y0 = Math.min(y0, p.y - r); y1 = Math.max(y1, p.y + r);
  }
  const m = 2;
  const left = Math.floor(x0 / UPP) - m, top = Math.ceil(y1 / UPP) + m;
  const w = Math.ceil(x1 / UPP) - left + m, h = top - Math.floor(y0 / UPP) + m;
  const ink = new Float32Array(w * h);
  // Convert to pixel space (y down).
  const segs = [];
  for (const s of strokes) {
    const pts = s.map(p => ({ x: p.x / UPP - left, y: top - p.y / UPP, r: (p.w || penWidth) / 2 / UPP }));
    if (pts.length === 1) segs.push([pts[0], pts[0]]);
    for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
  }
  for (const [a, b] of segs) {
    const rmax = Math.max(a.r, b.r) + 1.5;
    const bx0 = Math.max(0, Math.floor(Math.min(a.x, b.x) - rmax)), bx1 = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x) + rmax));
    const by0 = Math.max(0, Math.floor(Math.min(a.y, b.y) - rmax)), by1 = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y) + rmax));
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      let t = L ? ((x - a.x) * dx + (y - a.y) * dy) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + dx * t, py = a.y + dy * t, r = a.r + (b.r - a.r) * t;
      const d = Math.hypot(x - px, y - py);
      const c = r + 0.5 - d;
      if (c > 0) { const i = y * w + x; ink[i] = Math.max(ink[i], c > 1 ? 1 : c); }
    }
  }
  return {
    id: id || `${source}-${char}-${Math.random().toString(36).slice(2, 9)}`,
    char, w, h, ink, baseline: top, source, created: Date.now(),
  };
}

/** Helper: ellipse polyline in font units. */
export function ellipse(cx, cy, rx, ry, n = 40, a0 = 0, a1 = Math.PI * 2) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

const L = (...xy) => { const o = []; for (let i = 0; i < xy.length; i += 2) o.push({ x: xy[i], y: xy[i + 1] }); return o; };

/** A tiny built-in "hand" so the app and tests have something to build from. */
export const DEMO_STROKES = {
  o: [ellipse(220, 250, 180, 240)],
  l: [L(80, 780, 70, 0)],
  i: [L(80, 480, 70, 0), L(85, 650, 86, 652)],
  n: [L(60, 500, 60, 0), [...L(60, 380), ...ellipse(220, 360, 160, 140, 16, Math.PI, 0).slice(1), ...L(380, 0)]],
  e: [[...L(40, 260, 380, 260), ...ellipse(210, 250, 170, 240, 30, 0, Math.PI * 1.75).slice(1)]],
  T: [L(20, 700, 520, 710), L(270, 705, 260, 0)],
  V: [L(20, 700, 260, 0, 500, 700)],
  A: [L(20, 0, 260, 710, 500, 0), L(120, 260, 400, 260)],
  H: [L(40, 710, 40, 0), L(440, 710, 440, 0), L(40, 360, 440, 360)],
  '.': [L(40, 30, 42, 32)],
  h: [L(60, 780, 60, 0), [...L(60, 380), ...ellipse(220, 360, 160, 140, 16, Math.PI, 0).slice(1), ...L(380, 0)]],
  t: [L(120, 700, 110, 0), L(20, 480, 260, 490)],
  th: [L(120, 700, 110, 0), L(20, 480, 600, 490), L(420, 780, 420, 0), [...L(420, 380), ...ellipse(560, 360, 140, 140, 16, Math.PI, 0).slice(1), ...L(700, 0)]],
};

export function demoSamples() {
  return Object.entries(DEMO_STROKES).map(([ch, st], i) => ({ ...strokesToSample(ch, st, { source: 'demo', id: `demo-${i}` }), created: i }));
}
