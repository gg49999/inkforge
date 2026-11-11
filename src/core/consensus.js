// Self-consistency vetting of labeled letter candidates.
//
// Forced alignment on joined handwriting mislabels a fair share of cuts. Real
// instances of a letter resemble each other, so we use edited-nearest-neighbour
// cleaning: describe every cut with a small baseline-registered bitmap, find
// its k most similar cuts across the whole pool (all pages), and keep it only
// if those neighbours mostly carry the same label. Mislabeled cuts end up
// surrounded by instances of the letter they really are.

import { field, resize, blur } from './raster.js';

const G = 24;          // frame size
const XH = 9;          // x-height in frame pixels
const BASE = 16;       // baseline row in frame

/** Candidate -> Float32Array(G*G) descriptor (registered, blurred, unit norm). */
export function descriptor(c) {
  const s = XH / Math.max(1, c.xHeight);
  const w = Math.max(1, Math.round(c.crop.w * s)), h = Math.max(1, Math.round(c.crop.h * s));
  const small = resize(field(c.crop.w, c.crop.h, c.crop.data), w, h);
  const f = field(G, G);
  const ox = Math.round((G - w) / 2), oy = Math.round(BASE - c.baselineInCrop * s);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x + ox, Y = y + oy;
    if (X >= 0 && Y >= 0 && X < G && Y < G) f.data[Y * G + X] = Math.max(f.data[Y * G + X], small.data[y * w + x]);
  }
  const b = blur(f, 1.0).data;
  let m = 0; for (const v of b) m += v; m /= b.length;
  let n = 0; for (let i = 0; i < b.length; i++) { b[i] -= m; n += b[i] * b[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < b.length; i++) b[i] /= n;
  return b;
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

function fillRatio(c) {
  let n = 0;
  for (const v of c.crop.data) if (v > 0.5) n++;
  return n / Math.max(1, c.crop.w * c.crop.h);
}

const fold = l => (l.length === 1 ? l.toLowerCase() : l);

/**
 * Vet candidates in place: sets c.consistency (0..1 share of neighbour vote for
 * its own label) and c.keep. k = neighbours consulted.
 */
export function vet(cands, { k = 9, minShare = 0.4, minSim = 0.35 } = {}) {
  const pool = [];
  for (const c of cands) {
    c.keep = false; c.consistency = 0; delete c.reject;
    if (fillRatio(c) > 0.5 && c.crop.w * c.crop.h > 40) { c.reject = 'ink blob'; continue; }
    c.desc = descriptor(c);
    pool.push(c);
  }
  const n = pool.length;
  const top = pool.map(() => []);
  for (let i = 0; i < n; i++) {
    const a = pool[i].desc;
    for (let j = i + 1; j < n; j++) {
      const s = dot(a, pool[j].desc);
      push(top[i], s, j, k); push(top[j], s, i, k);
    }
  }
  // Label priors: frequent letters (e, t) would otherwise out-vote rare ones.
  const freq = new Map();
  for (const c of pool) freq.set(c.label, (freq.get(c.label) || 0) + 1);
  const prior = l => Math.sqrt((freq.get(l) || 1) / n);
  for (let i = 0; i < n; i++) {
    const c = pool[i];
    const votes = new Map();
    let total = 0;
    for (const { s, j } of top[i]) {
      if (s < minSim) continue;
      const w = s * s;
      const l = pool[j].label;
      votes.set(l, (votes.get(l) || 0) + w);
      if (fold(l) !== l || fold(l) !== c.label) {
        // Case variants (o/O, s/S...) count as half agreement.
        if (l !== c.label && fold(l) === fold(c.label)) votes.set(c.label, (votes.get(c.label) || 0) + w * 0.5);
      }
      total += w;
    }
    const own = votes.get(c.label) || 0;
    let best = null, bestV = 0;
    for (const [l, v] of votes) if (l !== c.label && v / prior(l) > bestV) { bestV = v / prior(l); best = l; }
    c.consistency = total ? own / total : 0;
    const ownN = own / prior(c.label);
    // Rare letters need fewer same-label neighbours, but must still win the prior-corrected vote.
    const need = minShare * Math.min(1, prior(c.label) / 0.12);
    c.keep = total > 0 && own > 0 && c.consistency >= need && ownN >= bestV && (votes.size > 0);
    if (!c.keep) c.reject = best ? `looks like ${best}` : 'no similar letters';
    // Small labels (rare letters) can't vote for themselves: fall back to a very clean single cut.
    if (!c.keep && countLabel(pool, c.label) < 3 && c.kind === 'single' && c.quality > 0.8) { c.keep = true; c.reject = undefined; c.consistency = 0.3; }
  }
  for (const c of pool) delete c.desc;
  return cands;
}

const labelCounts = new WeakMap();
function countLabel(pool, label) {
  let m = labelCounts.get(pool);
  if (!m) { m = new Map(); for (const c of pool) m.set(c.label, (m.get(c.label) || 0) + 1); labelCounts.set(pool, m); }
  return m.get(label) || 0;
}

function push(list, s, j, k) {
  if (list.length < k) { list.push({ s, j }); if (list.length === k) list.sort((a, b) => a.s - b.s); return; }
  if (s <= list[0].s) return;
  list[0] = { s, j };
  // Restore ascending order (insertion).
  for (let i = 0; i < list.length - 1 && list[i].s > list[i + 1].s; i++) { const t = list[i]; list[i] = list[i + 1]; list[i + 1] = t; }
}
