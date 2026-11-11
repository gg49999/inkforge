// Sample (normalized ink bitmap) -> positioned TrueType outline, with the
// style transforms (weight, slant) and the "natural variation" model
// (angle / baseline / size / spacing / shape wobble) applied in vector space.

import { UPP } from './constants.js';
import { field, pad, blur, embolden, despeckle } from './raster.js';
import { traceField, toQuadPoints, signedArea } from './trace.js';
import { rng } from './raster.js';

/**
 * Trace a sample into polygons in font units (y up, baseline at 0),
 * x measured from the sample's left edge. Cached per (sample, weight).
 */
const traceCache = new Map();
export function samplePolygons(sample, { weight = 0 } = {}) {
  const key = sample.id + '|' + weight.toFixed(2) + '|' + contentKey(sample);
  const hit = traceCache.get(key);
  if (hit) return hit;
  const m = Math.ceil(Math.abs(weight) / UPP) + 3;
  let f = pad(field(sample.w, sample.h, sample.ink instanceof Float32Array ? sample.ink : Float32Array.from(sample.ink)), m, 0);
  f = despeckle(f, 10);
  f = weight ? embolden(f, weight / UPP) : blur(f, 0.5);
  const polys = traceField(f, { minArea: 8, eps: 0.3, smooth: 1 });
  const out = polys.map(p => p.map(pt => ({ x: (pt.x - m) * UPP, y: (sample.baseline - (pt.y - m)) * UPP })));
  if (traceCache.size > 4000) traceCache.clear();
  traceCache.set(key, out);
  return out;
}

export function clearTraceCache() { traceCache.clear(); }

/** Cheap fingerprint so edited samples (same id, new pixels/baseline) re-trace. */
function contentKey(s) {
  let h = 2166136261 ^ s.w ^ (s.h << 12) ^ Math.round(s.baseline * 16);
  const step = Math.max(1, Math.floor(s.ink.length / 512));
  for (let i = 0; i < s.ink.length; i += step) { h ^= Math.round(s.ink[i] * 255); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function bounds(polys) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const q of p) {
    if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
    if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

/** Gaussian-ish random in [-1,1]*~2 from a uniform rng. */
function gauss(r) {
  return (r() + r() + r() - 1.5) / 0.5; // sd ~ 1
}

/**
 * A variation draw: concrete offsets for one synthesized variant.
 * `vary` holds standard deviations: { angle (deg), baseline (units),
 * scale (fraction), spacing (units), wobble (units) }.
 */
export function drawVariation(vary, seed) {
  const r = rng(seed);
  const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
  return {
    angle: clamp(gauss(r) * (vary.angle || 0), 3 * (vary.angle || 0)),
    baseline: clamp(gauss(r) * (vary.baseline || 0), 3 * (vary.baseline || 0)),
    scale: 1 + clamp(gauss(r) * (vary.scale || 0), 3 * (vary.scale || 0)),
    spacing: clamp(gauss(r) * (vary.spacing || 0), 3 * (vary.spacing || 0)),
    wobble: vary.wobble || 0,
    waves: Array.from({ length: 3 }, () => ({
      fx: (0.004 + r() * 0.01) * (r() < 0.5 ? -1 : 1),
      fy: (0.004 + r() * 0.01) * (r() < 0.5 ? -1 : 1),
      px: r() * Math.PI * 2, py: r() * Math.PI * 2,
    })),
    // Pen pressure (stroke growth in units, quantized so traces can be cached)
    // and how wide the hand made this copy.
    weight: 2 * Math.round(clamp(gauss(r) * (vary.weight || 0), 3 * (vary.weight || 0)) / 2),
    width: 1 + clamp(gauss(r) * (vary.width || 0), 3 * (vary.width || 0)),
  };
}

/** Apply slant + a variation draw to polygons (font units). */
export function transformPolys(polys, { slant = 0, variation = null, sizeScale = 1 } = {}) {
  const b = bounds(polys);
  const cx = (b.x0 + b.x1) / 2;
  const sh = Math.tan((slant * Math.PI) / 180);
  let cos = 1, sin = 0, s = sizeScale, dy = 0, waves = null, amp = 0, wx = 1;
  if (variation) {
    const a = (variation.angle * Math.PI) / 180;
    cos = Math.cos(a); sin = Math.sin(a);
    s *= variation.scale; dy = variation.baseline;
    waves = variation.waves; amp = variation.wobble;
    wx = variation.width || 1;
  }
  return polys.map(p => p.map(q => {
    let x = q.x - cx, y = q.y;
    // Smooth low-frequency displacement field = the hand never draws the same curve twice.
    if (waves && amp) {
      let wx = 0, wy = 0;
      for (const w of waves) {
        wx += Math.sin(w.fx * q.x + w.fy * q.y + w.px);
        wy += Math.sin(w.fy * q.x - w.fx * q.y + w.py);
      }
      x += (wx / waves.length) * amp;
      y += (wy / waves.length) * amp;
    }
    x *= s * wx; y *= s;
    // Rotate about the glyph's baseline center (negative angle = clockwise lean).
    const rx = x * cos + y * sin, ry = -x * sin + y * cos;
    return { x: rx + cx + ry * sh, y: ry + dy };
  }));
}

/**
 * Turn polygons into a positioned glyph:
 *   { contours: [[{x,y,on}]], advance, xMin, yMin, xMax, yMax }
 * Ink starts at x = lsb; advance = ink width + lsb + rsb.
 */
export function buildOutline(polys, { lsb = 50, rsb = 50, minAdvance = 0 } = {}) {
  if (!polys.length) return { contours: [], advance: Math.max(minAdvance, lsb + rsb), xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  const b = bounds(polys);
  const shift = lsb - b.x0;
  const contours = [];
  for (const p of polys) {
    // TrueType wants outer contours clockwise in y-up space. The y flip from
    // sample space leaves them counter-clockwise, so reverse every contour
    // (holes flip with them and stay correct).
    const pts = toQuadPoints(p.map(q => ({ x: q.x + shift, y: q.y })).reverse(), { cornerDeg: 50, straightLen: 60 });
    const rounded = [];
    for (const q of pts) {
      const r = { x: Math.round(q.x), y: Math.round(q.y), on: q.on };
      const last = rounded[rounded.length - 1];
      if (last && last.x === r.x && last.y === r.y) { if (r.on) last.on = true; continue; }
      rounded.push(r);
    }
    while (rounded.length > 1) {
      const a = rounded[0], z = rounded[rounded.length - 1];
      if (a.x === z.x && a.y === z.y) { a.on = a.on || z.on; rounded.pop(); } else break;
    }
    if (rounded.length >= 3 && Math.abs(signedArea(rounded)) > 4) contours.push(rounded);
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of contours) for (const q of c) {
    if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
  }
  if (!contours.length) return { contours: [], advance: Math.max(minAdvance, lsb + rsb), xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  const advance = Math.max(minAdvance, Math.round(b.x1 - b.x0 + lsb + rsb));
  return { contours, advance, xMin: x0, yMin: y0, xMax: x1, yMax: y1 };
}

/**
 * Horizontal ink profile of an outline, used for kerning:
 * for each band of `step` units between lo and hi, the min and max ink x.
 * Computed by scan-converting polygon edges (crossings are good enough).
 */
export function profile(contours, { lo = -300, hi = 900, step = 20 } = {}) {
  const n = Math.ceil((hi - lo) / step);
  const L = new Float32Array(n).fill(Infinity), R = new Float32Array(n).fill(-Infinity);
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length];
      const ya = Math.min(a.y, b.y), yb = Math.max(a.y, b.y);
      const k0 = Math.max(0, Math.floor((ya - lo) / step)), k1 = Math.min(n - 1, Math.floor((yb - lo) / step));
      for (let k = k0; k <= k1; k++) {
        const y = Math.min(yb, Math.max(ya, lo + (k + 0.5) * step));
        const t = yb === ya ? 0 : (y - a.y) / (b.y - a.y);
        const x = a.x + (b.x - a.x) * Math.max(0, Math.min(1, t));
        if (x < L[k]) L[k] = x; if (x > R[k]) R[k] = x;
      }
    }
  }
  return { L, R, lo, step, n };
}
