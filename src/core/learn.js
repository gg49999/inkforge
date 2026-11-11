// Learned handwriting model: a statistical shape model of the writer's hand.
//
// Learning (per character, from the writer's own samples):
//   1. every sample is placed in a common frame (baseline-aligned, centred on
//      its ink) and turned into a signed distance field (SDF) on a coarse grid;
//   2. the most typical sample (medoid) is the template; each other sample is
//      registered to it with diffeomorphic-style "demons" registration, giving a
//      smooth displacement field = how this copy differs from the typical one;
//   3. principal-component analysis of those fields finds the main *modes* in
//      which the writer's version of that letter varies (lean, loop size,
//      width, stroke reach...), with their variances.
//   Letters with too few samples borrow "global" modes learned by pooling the
//   (centred) fields of every well-sampled letter: the hand's general habits.
//
// Generation: pick one of the writer's real drawings as a base, draw mode
// coefficients from the learned (Gaussian) distribution scaled by a
// "creativity" temperature, and warp the base's high-resolution SDF with the
// resulting smooth field. Output is a normal sample (crisp outline, real
// strokes), so any number of new, plausible copies can be produced.

import { UPP } from './constants.js';
import { field, mask, signedDistance, sample as bilinear, rng, hashString } from './raster.js';

const CELL = 16;                         // font units per coarse cell
const FX0 = -480, FX1 = 480;             // frame x (units) around the ink centroid
const FY0 = -320, FY1 = 1040;            // frame y (units) from the baseline (up)
export const GW = (FX1 - FX0) / CELL;    // 60
export const GH = (FY1 - FY0) / CELL;    // 85
const N = GW * GH;
const SDF_CLAMP = 10;                    // cells
const MIN_PER_CHAR = 3;                  // samples needed for a per-letter model
const MAX_MODES = 8;

const gauss = r => (r() + r() + r() - 1.5) * 2;

// ------------------------------------------------------------ geometry ---

export function inkCentroidX(s) {
  let sx = 0, sw = 0;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const v = s.ink[y * s.w + x]; if (v > 0.2) { sx += x * v; sw += v; } }
  return sw ? sx / sw : s.w / 2;
}

/** Coarse SDF (cells, + inside) of a sample in the common frame. */
export function coarseSDF(s, cx) {
  const cov = new Float32Array(N);
  const k = CELL / UPP; // sample px per cell (4)
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const ux = FX0 + (i + 0.5) * CELL, uy = FY1 - (j + 0.5) * CELL;
    const px = cx + ux / UPP, py = s.baseline - uy / UPP;
    let acc = 0, n = 0;
    for (let dy = -k / 2 + 0.5; dy < k / 2; dy++) for (let dx = -k / 2 + 0.5; dx < k / 2; dx++) {
      const x = Math.round(px + dx), y = Math.round(py + dy);
      if (x >= 0 && y >= 0 && x < s.w && y < s.h) acc += s.ink[y * s.w + x];
      n++;
    }
    cov[j * GW + i] = acc / n;
  }
  const m = mask(GW, GH);
  for (let i = 0; i < N; i++) m.data[i] = cov[i] > 0.3 ? 1 : 0;
  const sd = signedDistance(m).data;
  for (let i = 0; i < N; i++) sd[i] = Math.max(-SDF_CLAMP, Math.min(SDF_CLAMP, sd[i]));
  return sd;
}

function smoothField(a, sigma) {
  // Separable gaussian on a GW x GH Float32 field (in place, returns a).
  const r = Math.ceil(sigma * 2.5), k = [];
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const t = new Float32Array(N);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) { const xx = Math.min(GW - 1, Math.max(0, x + i)); acc += a[y * GW + xx] * k[i + r]; }
    t[y * GW + x] = acc;
  }
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) { const yy = Math.min(GH - 1, Math.max(0, y + i)); acc += t[yy * GW + x] * k[i + r]; }
    a[y * GW + x] = acc;
  }
  return a;
}

function sampleGrid(a, x, y) {
  if (x < 0) x = 0; else if (x > GW - 1) x = GW - 1;
  if (y < 0) y = 0; else if (y > GH - 1) y = GH - 1;
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(GW - 1, x0 + 1), y1 = Math.min(GH - 1, y0 + 1), fx = x - x0, fy = y - y0;
  return (a[y0 * GW + x0] * (1 - fx) + a[y0 * GW + x1] * fx) * (1 - fy) + (a[y1 * GW + x0] * (1 - fx) + a[y1 * GW + x1] * fx) * fy;
}

/**
 * Demons registration: find a smooth field v (cells) such that
 * moving(x + v(x)) ~ fixed(x). Returns { vx, vy, err }.
 */
export function register(fixed, moving, { iters = 90, sigma = 2.2, step = 1 } = {}) {
  const vx = new Float32Array(N), vy = new Float32Array(N);
  const w = new Float32Array(N);
  let err = 0;
  for (let it = 0; it < iters; it++) {
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      w[i] = sampleGrid(moving, x + vx[i], y + vy[i]);
    }
    err = 0;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x;
      const gx = (w[y * GW + Math.min(GW - 1, x + 1)] - w[y * GW + Math.max(0, x - 1)]) / 2;
      const gy = (w[Math.min(GH - 1, y + 1) * GW + x] - w[Math.max(0, y - 1) * GW + x]) / 2;
      const d = fixed[i] - w[i];
      err += d * d;
      const den = gx * gx + gy * gy + d * d + 1e-3;
      // Gradient points uphill (towards inside); move sampling point so w -> fixed.
      vx[i] += step * (d * gx) / den;
      vy[i] += step * (d * gy) / den;
    }
    smoothField(vx, sigma); smoothField(vy, sigma);
  }
  return { vx, vy, err: Math.sqrt(err / N) };
}

// ---------------------------------------------------------------- PCA ---

/** Top-k principal components of centred vectors (rows), via the Gram matrix. */
function pca(rows, k) {
  const n = rows.length;
  if (n < 2) return { comps: [], vars: [] };
  const G = Array.from({ length: n }, () => new Float64Array(n));
  for (let a = 0; a < n; a++) for (let b = a; b < n; b++) {
    let s = 0; const ra = rows[a], rb = rows[b];
    for (let i = 0; i < ra.length; i++) s += ra[i] * rb[i];
    G[a][b] = G[b][a] = s;
  }
  const comps = [], vars = [];
  const r = rng(12345);
  for (let c = 0; c < Math.min(k, n - 1); c++) {
    let e = Float64Array.from({ length: n }, () => r() - 0.5);
    let lambda = 0;
    for (let it = 0; it < 200; it++) {
      const nx = new Float64Array(n);
      for (let a = 0; a < n; a++) { let s = 0; for (let b = 0; b < n; b++) s += G[a][b] * e[b]; nx[a] = s; }
      // deflate previously found components
      let norm = 0; for (const v of nx) norm += v * v; norm = Math.sqrt(norm);
      if (norm < 1e-12) break;
      for (let a = 0; a < n; a++) nx[a] /= norm;
      lambda = norm; e = nx;
    }
    if (lambda < 1e-9) break;
    // Component in field space: sum_a e_a * row_a, normalised.
    const dim = rows[0].length, phi = new Float32Array(dim);
    for (let a = 0; a < n; a++) { const ra = rows[a], ea = e[a]; for (let i = 0; i < dim; i++) phi[i] += ea * ra[i]; }
    let nn = 0; for (const v of phi) nn += v * v; nn = Math.sqrt(nn) || 1;
    for (let i = 0; i < dim; i++) phi[i] /= nn;
    comps.push(phi);
    vars.push(lambda / (n - 1));
    // Deflate Gram matrix: G -= lambda * e e^T
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) G[a][b] -= lambda * e[a] * e[b];
  }
  return { comps, vars };
}

// -------------------------------------------------------------- model ---

export function modelKey(samples) {
  let h = 2166136261;
  for (const s of samples.slice().sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (s.disabled) continue;
    for (const c of s.id + '|' + s.char) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  }
  return (h >>> 0).toString(36);
}

/**
 * Train the model. samples: the library (real + fill-in). Returns
 * { chars: Map char -> { bases, modes, vars, explained, trained }, global, stats }.
 * Fill-ins are used as bases (shapes) but only real handwriting trains modes.
 */
export function train(samples, { onProgress = null } = {}) {
  const byChar = new Map();
  for (const s of samples) {
    if (s.disabled || [...s.char].length !== 1) continue;
    if (!byChar.has(s.char)) byChar.set(s.char, []);
    byChar.get(s.char).push(s);
  }
  const chars = new Map();
  const pooled = [];
  let done = 0;
  const total = [...byChar.values()].reduce((a, l) => a + l.length, 0);
  for (const [ch, list] of byChar) {
    const real = list.filter(s => s.source !== 'fill-in');
    const prep = list.map(s => { const cx = inkCentroidX(s); return { s, cx, sdf: coarseSDF(s, cx) }; });
    const entry = { bases: prep, modes: [], vars: [], explained: 0, trained: real.length, medoid: prep[0] };
    const trainSet = prep.filter(p => p.s.source !== 'fill-in');
    if (trainSet.length >= MIN_PER_CHAR) {
      // Medoid: the sample closest (SDF L2) to all others.
      let best = Infinity;
      for (const a of trainSet) {
        let d = 0;
        for (const b of trainSet) { if (a === b) continue; for (let i = 0; i < N; i++) { const t = a.sdf[i] - b.sdf[i]; d += t * t; } }
        if (d < best) { best = d; entry.medoid = a; }
      }
      // Fields from the medoid to each sample, centred.
      const fields = trainSet.map(p => {
        if (p === entry.medoid) return new Float32Array(2 * N);
        const { vx, vy } = register(p.sdf, entry.medoid.sdf);
        const f = new Float32Array(2 * N); f.set(vx); f.set(vy, N);
        return f;
      });
      const mu = new Float32Array(2 * N);
      for (const f of fields) for (let i = 0; i < 2 * N; i++) mu[i] += f[i] / fields.length;
      const centred = fields.map(f => f.map((v, i) => v - mu[i]));
      const { comps, vars } = pca(centred, MAX_MODES);
      // Where each real drawing already sits along each mode (its coefficients),
      // so generation from that drawing applies only the *difference*.
      trainSet.forEach((p, k) => { p.z = comps.map(phi => { let s = 0; const c = centred[k]; for (let i = 0; i < c.length; i++) s += c[i] * phi[i]; return s; }); });
      const totalVar = centred.reduce((a, f) => a + f.reduce((s, v) => s + v * v, 0), 0) / Math.max(1, fields.length - 1);
      entry.modes = comps; entry.vars = vars; entry.mu = mu;
      entry.explained = totalVar ? vars.reduce((a, b) => a + b, 0) / totalVar : 0;
      pooled.push(...centred);
    }
    chars.set(ch, entry);
    done += list.length;
    if (onProgress) onProgress(done / total);
  }
  // Global habits: modes of the pooled, per-letter-centred fields.
  const g = pca(pooled, MAX_MODES);
  const global = { modes: g.comps, vars: g.vars, trainedOn: pooled.length };
  return { chars, global, stats: { characters: chars.size, modelled: [...chars.values()].filter(e => e.modes.length).length, fieldsLearned: pooled.length } };
}

// --------------------------------------------------------- generation ---

const hiresCache = new WeakMap();
function hiresSDF(s) {
  let h = hiresCache.get(s);
  if (h) return h;
  const m = mask(s.w, s.h);
  for (let i = 0; i < m.data.length; i++) m.data[i] = s.ink[i] > 0.5 ? 1 : 0;
  h = signedDistance(m);
  hiresCache.set(s, h);
  return h;
}

/** The deformation model for a character (its own modes, else the global habits). */
export function modesFor(model, ch) {
  const e = model.chars.get(ch);
  if (e && e.modes.length) return { modes: e.modes, vars: e.vars, own: true };
  return { modes: model.global.modes, vars: model.global.vars, own: false };
}

/** Warp a base sample by a coarse field (cells) and return a new sample. */
export function warpSample(base, cx, vx, vy, { id, char, source = 'learned' } = {}) {
  let maxD = 0;
  for (let i = 0; i < N; i++) maxD = Math.max(maxD, Math.abs(vx[i]), Math.abs(vy[i]));
  const marginPx = Math.ceil((maxD * CELL) / UPP) + 4;
  const W = base.w + 2 * marginPx, H = base.h + 2 * marginPx;
  const sdf = hiresSDF(base);
  const ink = new Float32Array(W * H);
  const pxPerCell = CELL / UPP;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const bx = x - marginPx, by = y - marginPx;        // base pixel coords
    // frame coords (cells) of this pixel
    const gx = ((bx - cx) * UPP - FX0) / CELL - 0.5, gy = (FY1 - (base.baseline - by) * UPP) / CELL - 0.5;
    const dx = sampleGrid(vx, gx, gy) * pxPerCell, dy = sampleGrid(vy, gx, gy) * pxPerCell;
    const sx = bx + dx, sy = by + dy;
    const v = sx < -1 || sy < -1 || sx > base.w || sy > base.h ? -SDF_CLAMP : bilinear(sdf, sx, sy);
    const c = 0.5 + v;
    ink[y * W + x] = c <= 0 ? 0 : c >= 1 ? 1 : c;
  }
  // Trim to ink + margin.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (ink[y * W + x] > 0.5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const p = 3;
  x0 = Math.max(0, x0 - p); y0 = Math.max(0, y0 - p); x1 = Math.min(W - 1, x1 + p); y1 = Math.min(H - 1, y1 + p);
  const cw = x1 - x0 + 1, ch2 = y1 - y0 + 1, out = new Float32Array(cw * ch2);
  for (let y = 0; y < ch2; y++) out.set(ink.subarray((y + y0) * W + x0, (y + y0) * W + x0 + cw), y * cw);
  return { id, char, w: cw, h: ch2, ink: out, baseline: base.baseline + marginPx - y0, source, created: 0 };
}

/** Field = sum_i z_i * phi_i for given coefficients. */
export function fieldFrom(modes, z) {
  const vx = new Float32Array(N), vy = new Float32Array(N);
  modes.forEach((phi, i) => {
    const zi = z[i] || 0;
    if (!zi) return;
    for (let k = 0; k < N; k++) { vx[k] += zi * phi[k]; vy[k] += zi * phi[N + k]; }
  });
  return { vx, vy };
}

const genCache = new Map();
/**
 * Generate the i-th learned copy of `ch` (deterministic). temperature scales
 * how far from the writer's typical variation it may go.
 */
export function generate(model, ch, i, { temperature = 1, key = '' } = {}) {
  const ck = `${key}|${ch}|${i}|${temperature}`;
  if (genCache.has(ck)) return genCache.get(ck);
  const e = model.chars.get(ch);
  if (!e || !e.bases.length) return null;
  const { modes, vars } = modesFor(model, ch);
  const r = rng(hashString(`learn:${ch}:${i}`));
  // Base: one of the writer's drawings (real ones preferred).
  const real = e.bases.filter(b => b.s.source !== 'fill-in');
  const pool = real.length ? real : e.bases;
  const base = pool[Math.floor(r() * pool.length)];
  const z = vars.map(v => {
    const sd = Math.sqrt(Math.max(0, v)) * temperature;
    return Math.max(-2.2 * sd, Math.min(2.2 * sd, gauss(r) * sd));
  });
  // A real drawing already has its own place along each mode: move it from
  // there to the target, rather than adding variation on top of variation.
  const own = modesFor(model, ch).own && base.z ? base.z : null;
  const dz = own ? z.map((v, k) => v - (own[k] || 0) * (temperature < 1 ? temperature : 1)) : z;
  const { vx, vy } = fieldFrom(modes, dz);
  const out = warpSample(base.s, base.cx, vx, vy, { id: `learned-${ch.codePointAt(0)}-${i}-${key}`, char: ch });
  if (genCache.size > 6000) genCache.clear();
  genCache.set(ck, out);
  return out;
}

/** Morph strip for one mode: base warped at -2σ..+2σ (for the pattern explorer). */
export function morph(model, ch, mode, steps = 5) {
  const e = model.chars.get(ch);
  if (!e) return [];
  const { modes, vars } = modesFor(model, ch);
  if (!modes[mode]) return [];
  const base = e.medoid || e.bases[0];
  const sd = Math.sqrt(vars[mode]);
  const out = [];
  for (let k = 0; k < steps; k++) {
    const t = -2 + (4 * k) / (steps - 1);
    const z = modes.map((_, i) => (i === mode ? t * sd : 0));
    const { vx, vy } = fieldFrom(modes, z);
    out.push({ t, sample: warpSample(base.s, base.cx, vx, vy, { id: `morph-${ch}-${mode}-${k}`, char: ch }) });
  }
  return out;
}
