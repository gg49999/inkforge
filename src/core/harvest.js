// Letter harvesting from transcribed, joined-up handwriting.
//
// Over-segmentation + dynamic programming, bootstrapped on the writer's own
// letters:
//   * each matched line becomes a deslanted, baseline-registered ink strip;
//   * the strip is over-cut into "atoms" at gaps and at thin joins;
//   * a DP assigns transcription characters to runs of atoms, scoring expected
//     width, word-gap agreement and — once prototypes exist — how much the
//     piece looks like the writer's other copies of that letter;
//   * kNN vetting keeps self-consistent letters, which become the prototypes
//     for the next round. A few rounds grow coverage while staying precise.

import { field, mask, components, resize, blur, median } from './raster.js';
import { lineChars, alignLines, charWidth } from './align.js';
import { vet } from './consensus.js';

const DEG = Math.PI / 180;
const G = 24, XH = 9, BASE = 16;

/** Build the deslanted ink strip for one detected line. */
function lineStrip(r, line) {
  const f = r.inkField, labels = r.labels;
  const ids = new Set(line.boxes.flatMap(b => b.comps.map(c => c.id)));
  const tanS = Math.tan(r.slant * DEG);
  const xh = line.xHeight;
  const up = Math.ceil(xh * 1.9), down = Math.ceil(xh * 1.1);
  const H = up + down;
  const xs0 = Math.floor(Math.min(...line.boxes.map(b => b.x0))) - 2;
  const xs1 = Math.ceil(Math.max(...line.boxes.map(b => b.x1))) + 2;
  const W = xs1 - xs0 + 1;
  const strip = new Float32Array(W * H);
  const rx0 = Math.min(...line.boxes.map(b => b.rx0)), rx1 = Math.max(...line.boxes.map(b => b.rx1));
  const y0 = Math.min(...line.boxes.map(b => b.y0)), y1 = Math.max(...line.boxes.map(b => b.y1));
  // Forward-map ink pixels (strip is sparse; this is fast and exact enough).
  for (let y = y0; y <= y1; y++) for (let x = rx0; x <= rx1; x++) {
    const i = y * f.w + x;
    const v = f.data[i];
    if (v <= 0.02) continue;
    let mine = ids.has(labels[i]);
    if (!mine && !labels[i]) mine = ids.has(labels[i - 1]) || ids.has(labels[i + 1]) || ids.has(labels[i - f.w]) || ids.has(labels[i + f.w]);
    if (!mine) continue;
    const base = line.icpt + line.slope * x;
    const sy = Math.round(y - base + up);
    const sx = Math.round(x + (y - base) * tanS) - xs0;
    if (sy < 0 || sy >= H || sx < 0 || sx >= W) continue;
    const k = sy * W + sx;
    if (v > strip[k]) strip[k] = v;
  }
  const prof = new Float32Array(W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) prof[x] += strip[y * W + x];
  return { W, H, up, xh, strip, prof, xs0, line, tanS };
}

/** Over-cut a strip into atoms: [{a, b}] column ranges, with gaps between. */
function atomsOf(S, strokeW) {
  const { W, prof, xh } = S;
  const pos = [];
  for (let x = 0; x < W; x++) if (prof[x] > 0.3) pos.push(prof[x]);
  const med = median(pos) || 1;
  const runs = [];
  let s = -1;
  for (let x = 0; x <= W; x++) {
    const on = x < W && prof[x] > 0.3;
    if (on && s < 0) s = x;
    if (!on && s >= 0) { runs.push([s, x]); s = -1; }
  }
  const atoms = [];
  const r = Math.max(2, Math.round(xh * 0.12));
  const minW = Math.max(2, Math.round(xh * 0.14));
  for (const [a, b] of runs) {
    const cuts = [a];
    for (let x = a + minW; x < b - minW; x++) {
      const v = prof[x];
      if (v > Math.max(strokeW * 1.6, med * 0.55)) continue;
      let isMin = true;
      for (let k = Math.max(a, x - r); k <= Math.min(b - 1, x + r); k++) if (prof[k] < v || (prof[k] === v && k < x)) { isMin = false; break; }
      if (isMin && x - cuts[cuts.length - 1] >= minW) cuts.push(x);
    }
    cuts.push(b);
    for (let i = 0; i < cuts.length - 1; i++) atoms.push({ a: cuts[i], b: cuts[i + 1] });
  }
  return atoms;
}

/** Descriptor of strip columns [a, b): registered 24x24, blurred, unit norm. */
function stripDescriptor(S, a, b) {
  const { W, H, strip, up, xh } = S;
  const s = XH / xh;
  const cw = b - a;
  const piece = new Float32Array(cw * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < cw; x++) piece[y * cw + x] = strip[y * W + a + x];
  const w = Math.max(1, Math.round(cw * s)), h = Math.max(1, Math.round(H * s));
  const small = resize(field(cw, H, piece), w, h);
  const f = field(G, G);
  const ox = Math.round((G - w) / 2), oy = Math.round(BASE - up * s);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x + ox, Y = y + oy;
    if (X >= 0 && Y >= 0 && X < G && Y < G) f.data[Y * G + X] = Math.max(f.data[Y * G + X], small.data[y * w + x]);
  }
  const d = blur(f, 1.0).data;
  let m = 0; for (const v of d) m += v; m /= d.length;
  let n = 0; for (let i = 0; i < d.length; i++) { d[i] -= m; n += d[i] * d[i]; }
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < d.length; i++) d[i] /= n;
  return d;
}

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

/** DP: chars -> runs of atoms. Returns [{char index, a, b (columns), sim}] */
function alignStrip(S, atoms, chars, protos, gapCut) {
  const n = atoms.length, m = chars.length;
  if (!n || !m) return [];
  const inkW = atoms.reduce((s, t) => s + (t.b - t.a), 0);
  const expAll = chars.reduce((s, c) => s + c.w, 0);
  const scale = inkW / Math.max(1e-6, expAll);
  const gapAfter = atoms.map((t, i) => (i < n - 1 ? atoms[i + 1].a - t.b : Infinity));
  const MAXK = 5;
  // Precompute descriptors for every atom run.
  const desc = new Map();
  const D = (i, k) => { const key = i * 8 + k; if (!desc.has(key)) desc.set(key, stripDescriptor(S, atoms[i].a, atoms[i + k - 1].b)); return desc.get(key); };
  const INF = 1e18;
  const cost = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const back = new Array((n + 1) * (m + 1));
  const id = (i, j) => i * (m + 1) + j;
  cost[0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const here = cost[id(i, j)];
    if (here >= INF) continue;
    const relax = (ni, nj, c, step) => { const k = id(ni, nj); if (here + c < cost[k]) { cost[k] = here + c; back[k] = { i, j, ...step }; } };
    if (i < n && j < m) {
      const ch = chars[j];
      const proto = protos.get(ch.c);
      for (let k = 1; k <= MAXK && i + k <= n; k++) {
        let inner = 0;
        for (let q = i; q < i + k - 1; q++) if (gapAfter[q] > gapCut) inner += 2.5;
        if (inner > 5) break;
        const w = atoms[i + k - 1].b - atoms[i].a;
        const rr = Math.log(Math.max(1, w) / Math.max(1, scale * ch.w));
        let c = 3 * rr * rr + inner;
        let sim = null;
        if (proto) { sim = dot(D(i, k), proto); c += 4 * Math.max(0, 0.8 - sim); }
        else c += 4 * (0.8 - 0.5);
        // Word-gap agreement at the end of this letter.
        if (i + k < n) {
          const big = gapAfter[i + k - 1] > gapCut;
          if (big && !ch.wordEnd) c += 1.0;
          if (!big && ch.wordEnd) c += 0.6;
        }
        relax(i + k, j + 1, c, { type: 'char', k, sim });
      }
    }
    if (i < n) relax(i + 1, j, 1.3 + (atoms[i].b - atoms[i].a) / Math.max(1, S.xh), { type: 'skipatom' });
    if (j < m) relax(i, j + 1, 1.8, { type: 'skipchar' });
  }
  const out = [];
  let i = n, j = m;
  while (i || j) {
    const b = back[id(i, j)];
    if (!b) break;
    if (b.type === 'char') out.push({ ci: b.j, a: atoms[b.i].a, b: atoms[b.i + b.k - 1].b, k: b.k, sim: b.sim, w: atoms[b.i + b.k - 1].b - atoms[b.i].a, exp: scale * chars[b.j].w });
    i = b.i; j = b.j;
  }
  return out.reverse();
}

/**
 * Remove join stubs: small ink fragments (left over from cutting a connecting
 * stroke) that sit inside the x-height band. Dots above the x-height (i, j)
 * and single-piece marks (punctuation) are kept.
 */
export function cleanStubs(crop, baselineInCrop, xHeight, { maxShare = 0.18 } = {}) {
  const { w, h, data } = crop;
  const m = mask(w, h);
  for (let i = 0; i < data.length; i++) m.data[i] = data[i] > 0.4 ? 1 : 0;
  const { labels, comps } = components(m);
  if (comps.length < 2) return crop;
  const biggest = comps.reduce((a, c) => (c.area > a.area ? c : a));
  const drop = new Set();
  for (const c of comps) {
    if (c === biggest || c.area > biggest.area * maxShare) continue;
    const above = c.y1 < baselineInCrop - xHeight * 0.95; // dot / accent above the x-height
    if (!above) drop.add(c.id);
  }
  if (!drop.size) return crop;
  const out = data.slice();
  // Clear the fragment and its soft halo.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = false;
    for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && xx >= 0 && yy < h && xx < w && drop.has(labels[yy * w + xx])) { hit = true; break; }
    }
    if (hit && !labels[y * w + x] || drop.has(labels[y * w + x])) out[y * w + x] = 0;
  }
  return { w, h, data: out };
}

/** Cut a letter from the strip and re-apply the writer's slant. */
function cutFromStrip(S, a, b) {
  const { W, H, strip, up, tanS } = S;
  // Trim empty rows / columns.
  let x0 = b, x1 = a - 1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = a; x < b; x++) if (strip[y * W + x] > 0.3) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < x0) return null;
  const pad = 3;
  // Strip column = image x + off(row), off(row) = (row - up) * tanS. Undo it.
  const offA = (y0 - pad - up) * tanS, offB = (y1 + pad - up) * tanS;
  const maxOff = Math.max(offA, offB), minOff = Math.min(offA, offB);
  const X0 = Math.floor(x0 - maxOff) - pad;
  const cw = Math.ceil(x1 - minOff) + pad - X0 + 1, ch = y1 - y0 + 1 + 2 * pad;
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    const sy = y + y0 - pad;
    if (sy < 0 || sy >= H) continue;
    const off = (sy - up) * tanS;
    for (let x = 0; x < cw; x++) {
      const sx = x + X0 + off;
      const xi = Math.floor(sx), fx = sx - xi;
      const v0 = xi >= a && xi < b ? strip[sy * W + xi] : 0;
      const v1 = xi + 1 >= a && xi + 1 < b ? strip[sy * W + xi + 1] : 0;
      out[y * cw + x] = v0 * (1 - fx) + v1 * fx;
    }
  }
  const baselineInCrop = up - (y0 - pad);
  const clean = cleanStubs({ w: cw, h: ch, data: out }, baselineInCrop, S.xh);
  return { w: cw, h: ch, data: clean.data, baselineInCrop };
}

/**
 * Harvest letters from analyzed pages.
 * pages: [{ r: analysis (with inkField, labels, lineReports, slant), text }]
 * Returns candidates (with keep flags) from the final round.
 */
export function harvest(pages, { rounds = 3, onRound = null } = {}) {
  // Prepare lines once.
  const lines = [];
  for (const [pi, { r, text }] of pages.entries()) {
    const texts = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const tls = texts.map(t => { const chars = lineChars(t); return { text: t, chars, expW: chars.reduce((s, c) => s + c.w, 0) }; });
    const infos = r.lineReports.map(l => ({ inkW: l.boxes.reduce((s, b) => s + (b.x1 - b.x0 + 1), 0) / Math.max(1, l.xHeight) }));
    const map = alignLines(infos, tls);
    const gapCut = r.wordGap ? Math.sqrt(Math.max(1, r.letterGap) * r.wordGap) : r.xHeight * 0.45;
    map.forEach((li, ti) => {
      if (li < 0) return;
      const line = r.lineReports[li];
      if (!line.boxes.length) return;
      const S = lineStrip(r, line);
      lines.push({ page: pi, li, ti, S, atoms: atomsOf(S, r.strokeWidth), chars: tls[ti].chars, gapCut });
    });
  }
  let protos = new Map();
  let cands = [];
  for (let round = 0; round < rounds; round++) {
    cands = [];
    for (const L of lines) {
      const al = alignStrip(L.S, L.atoms, L.chars, protos, L.gapCut);
      for (const s of al) {
        const cut = cutFromStrip(L.S, s.a, s.b);
        if (!cut) continue;
        const rr = Math.log(Math.max(1, s.w) / Math.max(1, s.exp));
        cands.push({
          label: L.chars[s.ci].c, page: L.page, line: L.li, textLine: L.ti, kind: s.k > 1 ? 'joined-atoms' : 'atom',
          quality: 1 / (1 + 3 * rr * rr) * (s.sim == null ? 0.8 : Math.max(0.2, s.sim + 0.2)),
          sim: s.sim, crop: { w: cut.w, h: cut.h, data: cut.data }, baselineInCrop: cut.baselineInCrop, xHeight: L.S.xh,
        });
      }
    }
    vet(cands, { k: 15, minShare: 0.25, minSim: 0.3 });
    // Prototypes from kept letters (need 2+ to trust).
    const next = new Map();
    const groups = new Map();
    for (const c of cands) if (c.keep) { if (!groups.has(c.label)) groups.set(c.label, []); groups.get(c.label).push(c); }
    for (const [label, list] of groups) {
      if (list.length < 2) continue;
      const p = new Float32Array(G * G);
      for (const c of list) { const d = descFromCand(c); for (let i = 0; i < p.length; i++) p[i] += d[i]; }
      let nn = 0; for (const v of p) nn += v * v; nn = Math.sqrt(nn) || 1;
      for (let i = 0; i < p.length; i++) p[i] /= nn;
      next.set(label, p);
    }
    protos = next;
    if (onRound) onRound(round, cands, protos);
  }
  return cands;
}

function descFromCand(c) {
  const S = { W: c.crop.w, H: c.crop.h, strip: c.crop.data, up: c.baselineInCrop, xh: c.xHeight };
  return stripDescriptor(S, 0, c.crop.w);
}

export { charWidth };
