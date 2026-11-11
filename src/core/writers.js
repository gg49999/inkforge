// Synthetic handwriting "writers" with known, controllable variation. Used by
// the model evaluation and to make the README demo (no real person's writing).
import { strokesToSample } from './synth.js';
import { SKELETONS } from './fillin.js';

export const FACTORS = ['slant', 'width', 'asc', 'pen', 'wobble'];
const gauss = r => (r() + r() + r() - 1.5) * 2;

export const STYLES = [
  { name: 'Neat print', note: 'upright, very consistent', slant: [0, 1.2], width: [1, 0.03], asc: [1, 0.03], pen: [44, 2], wobble: 3, tremor: 0 },
  { name: 'Fast slanted', note: 'strong right lean that varies', slant: [15, 5], width: [0.88, 0.06], asc: [1.05, 0.06], pen: [36, 4], wobble: 9, tremor: 0 },
  { name: 'Wide & round', note: 'variation mostly in width', slant: [2, 1.5], width: [1.15, 0.16], asc: [0.95, 0.04], pen: [56, 4], wobble: 5, tremor: 0 },
  { name: 'Tall loopy', note: 'variation mostly in ascender/descender reach', slant: [6, 2.5], width: [0.95, 0.05], asc: [1.2, 0.16], pen: [40, 3], wobble: 7, tremor: 0 },
  { name: 'Messy', note: 'everything varies a lot', slant: [5, 8], width: [1, 0.14], asc: [1, 0.14], pen: [50, 10], wobble: 22, tremor: 0 },
  { name: 'Shaky', note: 'small shape variation, strong tremor', slant: [0, 2], width: [1, 0.05], asc: [1, 0.05], pen: [42, 3], wobble: 4, tremor: 8 },
];

function densify(st, step = 14) {
  const out = [st[0]];
  for (let i = 1; i < st.length; i++) {
    const a = st[i - 1], b = st[i], d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(d / step));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
  }
  return out;
}

/** The writer used by "Load demo writer" and the README images. */
export const DEMO_STYLE = { name: 'Demo writer', slant: [8, 3], width: [0.95, 0.06], asc: [1.08, 0.07], pen: [44, 4], wobble: 8, tremor: 0.6 };

/**
 * A complete synthetic handwriting library: several copies of every character
 * (more for lowercase, which repeats most), like a filled set of capture sheets.
 */
export function demoLibrary(chars, rngFor, style = DEMO_STYLE) {
  const out = [];
  for (const ch of chars) {
    if (!SKELETONS[ch]) continue;
    const n = /[a-z]/.test(ch) ? 6 : /[0-9]/.test(ch) ? 4 : /[A-Z]/.test(ch) ? 3 : 1;
    const r = rngFor(ch);
    for (let i = 0; i < n; i++) {
      const s = makeSample(style, ch, r, `demo-${ch.codePointAt(0)}-${i}`).s;
      s.source = 'demo'; s.created = i;
      out.push(s);
    }
  }
  return out;
}

/** One handwritten-looking copy of `ch` in `style`. Returns { s: sample, gt: [factor values] }. */
export function makeSample(style, ch, r, id) {
  const g = (m, s) => m + gauss(r) * s;
  const f = { slant: g(...style.slant), width: Math.max(0.6, g(...style.width)), asc: Math.max(0.7, g(...style.asc)), pen: Math.max(20, g(...style.pen)), wobble: style.wobble * (0.4 + r() * 1.2) };
  const sk = SKELETONS[ch].map(st => densify(st));
  let x0 = Infinity, x1 = -Infinity; for (const st of sk) for (const p of st) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); }
  const cx = (x0 + x1) / 2, sh = Math.tan((f.slant * Math.PI) / 180);
  const waves = Array.from({ length: 3 }, () => ({ fx: 0.004 + r() * 0.01, fy: 0.004 + r() * 0.01, p: r() * 6.28, q: r() * 6.28 }));
  const strokes = sk.map(st => st.map(p => {
    let x = cx + (p.x - cx) * f.width;
    let y = p.y > 500 ? 500 + (p.y - 500) * f.asc : p.y < 0 ? p.y * f.asc : p.y;
    let wx = 0, wy = 0; for (const w of waves) { wx += Math.sin(w.fx * p.y + w.p); wy += Math.sin(w.fy * p.x + w.q); }
    x += (wx / 3) * f.wobble + gauss(r) * style.tremor; y += (wy / 3) * f.wobble + gauss(r) * style.tremor;
    return { x: x + y * sh, y };
  }));
  const s = strokesToSample(ch, strokes, { penWidth: f.pen, id, source: 'synthetic' });
  return { s, gt: FACTORS.map(k => f[k]) };
}
