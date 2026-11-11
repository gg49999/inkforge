// Deep evaluation of the learned handwriting model.
//   node scripts/learn-eval.mjs            -> reports/learn-eval/index.html
//
// 1. Six synthetic "writers" with known ground-truth variation (slant, width,
//    ascender reach, pen weight, smooth wobble, tremor). 20 training + 20
//    held-out copies per letter. Because the true causes of variation are
//    known, we can check whether the model's patterns recover them.
// 2. Metrics, for the learned model and the previous method (random tilt /
//    scale / wobble of real copies) as a baseline:
//      - 1-NN two-sample test vs held-out real copies (50% = indistinguishable)
//      - novelty ratio: distance of generated copies to the training set vs
//        distance of genuinely new real copies (1 = as novel as a real copy;
//        << 1 = copying; >> 1 = off-distribution)
//      - feature matching (width, height, slant, ink weight): mean offset in
//        held-out SDs, and spread ratio (1 = same variability)
//      - ground-truth recovery: |correlation| between learned pattern scores
//        and the true factors
//      - generalisation: variance of *unseen* copies explained by the patterns,
//        as a learning curve over 3 / 5 / 10 / 20 training copies
// 3. The same (where applicable) on the user's real handwriting.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { UPP } from '../src/core/constants.js';
import { rng, hashString } from '../src/core/raster.js';
import { STYLES, FACTORS, makeSample } from '../src/core/writers.js';
import { train, generate, register, coarseSDF, inkCentroidX } from '../src/core/learn.js';
import { samplePolygons, transformPolys, drawVariation } from '../src/core/glyph.js';
import { DEFAULT_SETTINGS } from '../src/core/fontbuilder.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports', 'learn-eval');
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(...a);
const gauss = r => (r() + r() + r() - 1.5) * 2;

// ------------------------------------------------------- synthetic writers ---
const LETTERS = ['a', 'e', 'g', 'h', 'k', 's', 't', '5', 'M'];

// ------------------------------------------------------------- baseline ---
// The previous method: a random real copy with random tilt/scale/wobble/
// pressure/width (placement bounce excluded so only shape is compared).
function rasterPolys(polys, ch, id) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of polys) for (const q of p) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const pad = 3, left = Math.floor(x0 / UPP) - pad, top = Math.ceil(y1 / UPP) + pad;
  const w = Math.ceil(x1 / UPP) - left + pad, h = top - Math.floor(y0 / UPP) + pad;
  const ink = new Float32Array(w * h), SS = 3;
  const P = polys.map(p => p.map(q => [q.x / UPP - left, top - q.y / UPP]));
  for (let y = 0; y < h; y++) for (let sy = 0; sy < SS; sy++) {
    const yy = y + (sy + 0.5) / SS, xs = [];
    for (const p of P) for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length];
      if ((ay <= yy) !== (by <= yy)) xs.push({ x: ax + ((yy - ay) / (by - ay)) * (bx - ax), d: by > ay ? 1 : -1 });
    }
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].d;
      if (!wind) continue;
      for (let x = Math.max(0, Math.floor(xs[i].x)); x < Math.min(w, Math.ceil(xs[i + 1].x)); x++) {
        const cover = Math.max(0, Math.min(x + 1, xs[i + 1].x) - Math.max(x, xs[i].x));
        ink[y * w + x] += cover / SS;
      }
    }
  }
  for (let i = 0; i < ink.length; i++) ink[i] = Math.min(1, ink[i]);
  return { id, char: ch, w, h, ink, baseline: top, source: 'baseline' };
}

function baselineCopy(trainSet, ch, i) {
  const r = rng(hashString(`base:${ch}:${i}`));
  const base = trainSet[Math.floor(r() * trainSet.length)];
  const v = drawVariation({ ...DEFAULT_SETTINGS.vary, baseline: 0, spacing: 0 }, hashString(`bv:${ch}:${i}`));
  const polys = samplePolygons(base, { weight: Math.max(-4, v.weight || 0) });
  return rasterPolys(transformPolys(polys, { variation: v }), ch, `baseline-${ch}-${i}`);
}

// -------------------------------------------------------------- metrics ---
function features(s) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, x0 = 1e9, x1 = -1e9, top = -1e9, bot = 1e9;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const v = s.ink[y * s.w + x]; if (v < 0.5) continue;
    const ux = x * UPP, uy = (s.baseline - y) * UPP;
    n++; sx += ux; sy += uy; sxx += ux * ux; syy += uy * uy; sxy += ux * uy;
    x0 = Math.min(x0, ux); x1 = Math.max(x1, ux); top = Math.max(top, uy); bot = Math.min(bot, uy);
  }
  const mx = sx / n, my = sy / n, cxy = sxy / n - mx * my, vyy = syy / n - my * my;
  return { width: x1 - x0, height: top - bot, slant: (Math.atan(cxy / Math.max(1, vyy)) * 180) / Math.PI, ink: (n * UPP * UPP) / 1000 };
}
const FEATS = ['width', 'height', 'slant', 'ink'];
const desc = s => coarseSDF(s, inkCentroidX(s));
const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) { const t = a[i] - b[i]; d += t * t; } return Math.sqrt(d); };
const meanOf = a => a.reduce((x, y) => x + y, 0) / a.length;
const sdOf = a => { const m = meanOf(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };

/** 1-NN two-sample test accuracy (0.5 = indistinguishable). */
function nnTest(A, B) {
  const all = [...A.map(d => ({ d, l: 0 })), ...B.map(d => ({ d, l: 1 }))];
  let ok = 0;
  for (let i = 0; i < all.length; i++) {
    let best = Infinity, lab = -1;
    for (let j = 0; j < all.length; j++) { if (i === j) continue; const d = dist(all[i].d, all[j].d); if (d < best) { best = d; lab = all[j].l; } }
    if (lab === all[i].l) ok++;
  }
  return ok / all.length;
}
/** Generated-to-train NN distance / held-out-to-train NN distance. */
function novelty(G, T, TR) {
  const nn = (x) => Math.min(...TR.map(t => dist(x, t)));
  return median(G.map(nn)) / median(T.map(nn));
}
function featureMatch(gen, test) {
  const fg = gen.map(features), ft = test.map(features), out = {};
  for (const k of FEATS) {
    const g = fg.map(f => f[k]), t = ft.map(f => f[k]), sd = sdOf(t) || 1;
    out[k] = { offset: Math.abs(meanOf(g) - meanOf(t)) / sd, spread: sdOf(g) / sd };
  }
  return out;
}
const corr = (a, b) => { const ma = meanOf(a), mb = meanOf(b); let n = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { n += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; } return da && db ? n / Math.sqrt(da * db) : 0; };

/** Variance of unseen copies explained by the letter's patterns. */
function heldOutEV(model, ch, testSamples) {
  const e = model.chars.get(ch);
  if (!e || !e.modes.length) return null;
  const N = e.medoid.sdf.length;
  let tot = 0, res = 0;
  for (const s of testSamples) {
    const { vx, vy } = register(coarseSDF(s, inkCentroidX(s)), e.medoid.sdf);
    const c = new Float32Array(2 * N);
    for (let i = 0; i < N; i++) { c[i] = vx[i] - e.mu[i]; c[N + i] = vy[i] - e.mu[N + i]; }
    let cc = 0; for (const v of c) cc += v * v;
    const r = c.slice();
    for (const phi of e.modes) { let z = 0; for (let i = 0; i < c.length; i++) z += c[i] * phi[i]; for (let i = 0; i < c.length; i++) r[i] -= z * phi[i]; }
    let rr = 0; for (const v of r) rr += v * v;
    tot += cc; res += rr;
  }
  return tot ? 1 - res / tot : null;
}

// ------------------------------------------------------------ rendering ---
const CELLW = 44, CELLH = 64, PER = 7, GAP = 18;
const GROUPS = ['Training (real)', 'Held-out (real, unseen)', 'Learned model', 'Previous method'];
function sheet(rows) {
  // rows: [{ groups: [[sample...] x4] }]
  const W = GROUPS.length * (PER * CELLW + GAP), H = rows.length * CELLH + 8;
  const img = new Float32Array(W * H * 3).fill(1);
  const colours = [[0.62, 0.15, 0.15], [0.45, 0.45, 0.45], [0.11, 0.17, 0.36], [0.25, 0.45, 0.25]];
  rows.forEach((row, ri) => row.groups.forEach((list, gi) => list.slice(0, PER).forEach((s, k) => {
    if (!s) return;
    const sc = 0.2, ox = gi * (PER * CELLW + GAP) + k * CELLW + 4, base = ri * CELLH + 50;
    for (let y = 0; y < CELLH; y++) for (let x = 0; x < CELLW - 4; x++) {
      const sx = Math.round((x - 0) / sc + (s.w / 2 - (CELLW - 4) / 2 / sc)), sy = Math.round((y + ri * CELLH - base) / sc + s.baseline);
      if (sx < 0 || sy < 0 || sx >= s.w || sy >= s.h) continue;
      const a = Math.min(1, s.ink[sy * s.w + sx]);
      const o = ((ri * CELLH + y) * W + ox + x) * 3;
      if (o < 0 || o >= img.length) continue;
      for (let c = 0; c < 3; c++) img[o + c] = img[o + c] * (1 - a) + colours[gi][c] * a;
    }
  })));
  for (let gi = 1; gi < GROUPS.length; gi++) { const x = gi * (PER * CELLW + GAP) - GAP / 2; for (let y = 0; y < H; y++) { const o = (y * W + x) * 3; img[o] = 0.85; img[o + 1] = 0.75; img[o + 2] = 0.75; } }
  return pngRGB(W, H, img);
}
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngRGB(W, H, f) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = Math.round(Math.max(0, Math.min(1, f[y * W * 3 + x])) * 255);
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// -------------------------------------------------------------- evaluate ---
function evaluateSet(name, trainByChar, testByChar, { gtByChar = null, curve = [] } = {}) {
  const allTrain = [...trainByChar.values()].flat();
  const t0 = Date.now();
  const model = train(allTrain);
  model.key = name;
  const trainMs = Date.now() - t0;
  const res = { name, trainMs, letters: {} };
  const rows = [];
  for (const [ch, tr] of trainByChar) {
    const te = testByChar.get(ch) || [];
    if (te.length < 4) continue;
    const n = te.length;
    const learned = Array.from({ length: n }, (_, i) => generate(model, ch, i + 1, { key: name })).filter(Boolean);
    const base = Array.from({ length: n }, (_, i) => baselineCopy(tr, ch, i));
    const D = { tr: tr.map(desc), te: te.map(desc), le: learned.map(desc), ba: base.map(desc) };
    const e = model.chars.get(ch);
    const L = {
      ownModel: !!(e && e.modes.length), patterns: e ? e.modes.length : 0,
      nn: { learned: nnTest(D.le, D.te), baseline: nnTest(D.ba, D.te), realVsReal: tr.length >= n ? nnTest(D.tr.slice(0, n), D.te) : null },
      novelty: { learned: novelty(D.le, D.te, D.tr), baseline: novelty(D.ba, D.te, D.tr) },
      features: { learned: featureMatch(learned, te), baseline: featureMatch(base, te) },
      heldOutEV: heldOutEV(model, ch, te),
    };
    if (gtByChar && e && e.modes.length) {
      const gt = gtByChar.get(ch); // aligned with tr order (train() preserves order within a char)
      const trainBases = e.bases.filter(b => b.z);
      const zs = trainBases.map(b => b.z), idx = trainBases.map(b => tr.indexOf(b.s));
      L.recovery = {};
      FACTORS.forEach((fname, fi) => {
        const truth = idx.map(i => gt[i][fi]);
        if (sdOf(truth) < 1e-6) return;
        let best = 0, bestMode = -1;
        for (let m = 0; m < Math.min(4, e.modes.length); m++) { const c = Math.abs(corr(truth, zs.map(z => z[m]))); if (c > best) { best = c; bestMode = m; } }
        L.recovery[fname] = { corr: best, mode: bestMode + 1 };
      });
    }
    res.letters[ch] = L;
    rows.push({ ch, groups: [tr, te, learned, base] });
  }
  // Learning curve on a few letters: retrain on n copies, measure held-out EV and 1-NN.
  if (curve.length) {
    res.curve = {};
    for (const n of curve) {
      const sub = new Map([...trainByChar].map(([c, l]) => [c, l.slice(0, n)]));
      const m = train([...sub.values()].flat()); m.key = name + ':n' + n;
      const ev = [], nn = [];
      for (const ch of ['a', 'e', 's', 'h']) {
        if (!sub.has(ch)) continue;
        const te = testByChar.get(ch); if (!te) continue;
        const v = heldOutEV(m, ch, te); if (v != null) ev.push(v);
        const gen = Array.from({ length: te.length }, (_, i) => generate(m, ch, i + 1, { key: m.key })).filter(Boolean);
        nn.push(nnTest(gen.map(desc), te.map(desc)));
      }
      res.curve[n] = { heldOutEV: ev.length ? meanOf(ev) : null, nn: nn.length ? meanOf(nn) : null };
    }
  }
  const png = sheet(rows);
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png';
  fs.writeFileSync(path.join(OUT, file), png);
  res.image = file; res.rowLabels = rows.map(r => r.ch);
  return res;
}

function summarize(res) {
  const L = Object.values(res.letters);
  const avg = f => { const v = L.map(f).filter(x => x != null && !Number.isNaN(x)); return v.length ? meanOf(v) : null; };
  const featAvg = (m, key) => avg(l => meanOf(FEATS.map(k => l.features[m][k][key])));
  const spreadErr = m => avg(l => meanOf(FEATS.map(k => Math.abs(Math.log(Math.max(0.05, l.features[m][k].spread))))));
  const rec = {};
  for (const f of FACTORS) { const v = L.map(l => l.recovery && l.recovery[f] ? l.recovery[f].corr : null).filter(x => x != null); if (v.length) rec[f] = meanOf(v); }
  return {
    nnLearned: avg(l => l.nn.learned), nnBaseline: avg(l => l.nn.baseline), nnRealVsReal: avg(l => l.nn.realVsReal),
    noveltyLearned: avg(l => l.novelty.learned), noveltyBaseline: avg(l => l.novelty.baseline),
    offsetLearned: featAvg('learned', 'offset'), offsetBaseline: featAvg('baseline', 'offset'),
    spreadErrLearned: spreadErr('learned'), spreadErrBaseline: spreadErr('baseline'),
    heldOutEV: avg(l => l.heldOutEV), recovery: rec,
  };
}

// ------------------------------------------------------------------ run ---
const report = { generated: new Date().toISOString(), styles: [], real: null };
for (const [si, style] of STYLES.entries()) {
  const trainBy = new Map(), testBy = new Map(), gtBy = new Map();
  for (const ch of LETTERS) {
    const r = rng(hashString(`style:${si}:${ch}`));
    const tr = [], te = [], gt = [];
    for (let i = 0; i < 20; i++) { const m = makeSample(style, ch, r, `s${si}-${ch}-tr${i}`); tr.push(m.s); gt.push(m.gt); }
    for (let i = 0; i < 20; i++) te.push(makeSample(style, ch, r, `s${si}-${ch}-te${i}`).s);
    trainBy.set(ch, tr); testBy.set(ch, te); gtBy.set(ch, gt);
  }
  const t0 = Date.now();
  const res = evaluateSet(style.name, trainBy, testBy, { gtByChar: gtBy, curve: [3, 5, 10, 20] });
  res.note = style.note; res.summary = summarize(res);
  report.styles.push(res);
  log(`${style.name}: ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(res.summary));
}

// Optional: your own handwriting (letters with >= 10 real copies), half/half split.
// Off by default so reports never contain personal handwriting unless asked:
//   node scripts/learn-eval.mjs --include-mine
const projFile = path.join(process.env.LOCALAPPDATA || '', 'Inkforge', 'project.json');
if (process.argv.includes('--include-mine') && fs.existsSync(projFile)) {
  const j = JSON.parse(fs.readFileSync(projFile, 'utf8'));
  const samples = j.samples.filter(s => s.source !== 'fill-in' && !s.disabled).map(s => ({ ...s, ink: Float32Array.from(Buffer.from(s.ink, 'base64'), v => v / 255) }));
  const by = new Map(); for (const s of samples) { if ([...s.char].length !== 1) continue; if (!by.has(s.char)) by.set(s.char, []); by.get(s.char).push(s); }
  const trainBy = new Map(), testBy = new Map();
  for (const [ch, list] of by) {
    if (list.length < 10) continue;
    const r = rng(hashString('split:' + ch));
    const sh = list.slice().sort(() => r() - 0.5);
    const half = Math.floor(sh.length / 2);
    trainBy.set(ch, sh.slice(0, half)); testBy.set(ch, sh.slice(half));
  }
  const t0 = Date.now();
  const res = evaluateSet('Your handwriting', trainBy, testBy);
  res.note = `${trainBy.size} letters with 10+ real copies, split half train / half held-out`;
  res.summary = summarize(res);
  report.real = res;
  log(`Your handwriting: ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(res.summary));
}
fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(report, null, 2));
log('wrote', path.join(OUT, 'metrics.json'));
