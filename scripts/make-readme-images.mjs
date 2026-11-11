// Renders the README images from the synthetic demo writer (never a real
// person's handwriting):  node scripts/make-readme-images.mjs  -> docs/images/
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { CHARSET } from '../src/core/constants.js';
import { rng, hashString } from '../src/core/raster.js';
import { demoLibrary } from '../src/core/writers.js';
import { makeFillIns } from '../src/core/fillin.js';
import { buildFont } from '../src/core/fontbuilder.js';
import { versionChain } from '../src/core/versions.js';
import { train, morph } from '../src/core/learn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });

// ----------------------------------------------------------- tiny canvas ---
class Img {
  constructor(w, h, bg = [253, 251, 246]) { this.w = w; this.h = h; this.d = new Float32Array(w * h * 3); for (let i = 0; i < w * h; i++) this.d.set(bg.map(v => v / 255), i * 3); }
  blend(x, y, a, c) { if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return; const o = (y * this.w + x) * 3; for (let k = 0; k < 3; k++) this.d[o + k] = this.d[o + k] * (1 - a) + (c[k] / 255) * a; }
  hline(y, c, alpha = 1) { for (let x = 0; x < this.w; x++) this.blend(x, Math.round(y), alpha, c); }
  png() {
    const { w, h } = this, raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = Math.round(Math.max(0, Math.min(1, this.d[y * w * 3 + x])) * 255);
    const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = b => { let c = 0xffffffff; for (const v of b) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (t, dd) => { const l = Buffer.alloc(4); l.writeUInt32BE(dd.length); const td = Buffer.concat([Buffer.from(t), dd]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  }
}

/** Fill TrueType contours (font units, y up) at (ox, base) with scale k (px per unit). */
function fillGlyph(img, contours, ox, base, k, colour, SS = 3) {
  const flat = contours.map(c => {
    const n = c.length, P = i => c[((i % n) + n) % n], pts = [];
    let s = c.findIndex(p => p.on); if (s < 0) s = 0;
    let cur = P(s); pts.push([cur.x, cur.y]);
    for (let k2 = 1; k2 <= n; k2++) {
      const p = P(s + k2);
      if (p.on) { pts.push([p.x, p.y]); cur = p; continue; }
      const nx = P(s + k2 + 1), end = nx.on ? nx : { x: (p.x + nx.x) / 2, y: (p.y + nx.y) / 2 };
      for (let t = 1; t <= 8; t++) { const u = t / 8; pts.push([(1 - u) ** 2 * cur.x + 2 * (1 - u) * u * p.x + u * u * end.x, (1 - u) ** 2 * cur.y + 2 * (1 - u) * u * p.y + u * u * end.y]); }
      cur = end; if (nx.on) k2++;
    }
    return pts.map(([x, y]) => [ox + x * k, base - y * k]);
  });
  let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
  for (const p of flat) for (const [x, y] of p) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  if (!isFinite(y0)) return;
  const cov = new Map();
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) for (let sy = 0; sy < SS; sy++) {
    const yy = y + (sy + 0.5) / SS, xs = [];
    for (const p of flat) for (let i = 0; i < p.length; i++) { const [ax, ay] = p[i], [bx, by] = p[(i + 1) % p.length]; if ((ay <= yy) !== (by <= yy)) xs.push({ x: ax + ((yy - ay) / (by - ay)) * (bx - ax), d: by > ay ? 1 : -1 }); }
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i].d; if (!wind) continue;
      for (let x = Math.floor(xs[i].x); x < Math.ceil(xs[i + 1].x); x++) {
        const c = Math.max(0, Math.min(x + 1, xs[i + 1].x) - Math.max(x, xs[i].x)) / SS;
        const key = y * 100000 + x; cov.set(key, (cov.get(key) || 0) + c);
      }
    }
  }
  for (const [key, a] of cov) img.blend(key % 100000, Math.floor(key / 100000), Math.min(1, a), colour);
}

/** Blit a sample bitmap (ink coverage) with its baseline at `base`. */
function blitSample(img, s, ox, base, scale, colour) {
  for (let y = 0; y < Math.ceil(s.h * scale); y++) for (let x = 0; x < Math.ceil(s.w * scale); x++) {
    const sx = Math.floor(x / scale), sy = Math.floor(y / scale);
    if (sx >= s.w || sy >= s.h) continue;
    img.blend(Math.round(ox + x), Math.round(base - s.baseline * scale + y), Math.min(1, s.ink[sy * s.w + sx]), colour);
  }
}

// ---------------------------------------------------------------- data ---
const NAVY = [29, 42, 90], RED = [162, 45, 45], GREY = [140, 140, 140];
log('demo writer...');
const lib = demoLibrary(CHARSET, ch => rng(hashString('demo:' + ch)));
const fills = makeFillIns(CHARSET, lib);
const samples = [...lib, ...fills];
const settings = { variants: 30, digitVariants: 30, learned: true, creativity: 1, family: 'Demo Hand' };
let t = Date.now();
const built = buildFont(samples, settings);
log(`font: ${built.stats.glyphs} glyphs in ${((Date.now() - t) / 1000).toFixed(1)}s`);
const glyph = new Map(), nvers = new Map();
for (const g of built.glyphInfo) { if (g.ligature) continue; glyph.set(g.char + '\u0000' + g.version, g); nvers.set(g.char, (nvers.get(g.char) || 0) + 1); }
function log(...a) { console.log(...a); }

// 1. Hero: lines of text set exactly as the font sets them (every repeat differs).
{
  const lines = ['Every letter has thirty versions, so the', 'same word never looks the same twice:', 'the the the the  letter letter letter', 'Handwriting to font, from a photo. 2026'];
  const k = 0.055, LH = 92, img = new Img(1600, lines.length * LH + 50);
  lines.forEach((text, i) => {
    const base = 80 + i * LH; img.hline(base + 3, [169, 196, 234], 0.8);
    const vs = versionChain(text, ch => nvers.get(ch) || 1);
    let x = 40;
    [...text].forEach((ch, j) => { const g = glyph.get(ch + '\u0000' + vs[j]) || glyph.get(ch + '\u0000' + 0); if (!g) { x += 12; return; } fillGlyph(img, g.outline.contours, x, base, k, NAVY); x += g.outline.advance * k; });
  });
  fs.writeFileSync(path.join(OUT, 'hero.png'), img.png());
}

// 2. All 30 versions of some characters: red = source copies, navy = learned copies.
{
  const rows = [...'aegst7M&'], k = 0.05, RH = 84, img = new Img(1700, rows.length * RH + 30);
  rows.forEach((ch, i) => {
    const base = 66 + i * RH; let x = 24;
    const gs = built.glyphInfo.filter(g => g.char === ch && !g.ligature).sort((a, b) => a.version - b.version);
    for (const g of gs) { fillGlyph(img, g.outline.contours, x, base, k, g.synthetic === 'learned' ? NAVY : g.synthetic ? GREY : RED); x += g.outline.advance * k; }
  });
  fs.writeFileSync(path.join(OUT, 'versions.png'), img.png());
}

// 3. Patterns the model learned: each row = one mode from -2 sd to +2 sd.
{
  const model = train(samples); model.key = 'readme';
  const plan = [['a', 0], ['a', 1], ['s', 0], ['g', 0]];
  const sc = 0.32, CW = 120, RH = 120, img = new Img(5 * CW + 40, plan.length * RH + 20);
  plan.forEach(([ch, m], i) => {
    const frames = morph(model, ch, m, 5);
    frames.forEach((f, j) => { if (f.sample) blitSample(img, f.sample, 30 + j * CW, 85 + i * RH, sc, j === 2 ? NAVY : [70, 90, 150]); });
  });
  fs.writeFileSync(path.join(OUT, 'patterns.png'), img.png());
}

// 4. Evaluation sheet (synthetic writer) from the last model evaluation run.
const evalSheet = path.join(ROOT, 'reports', 'learn-eval', 'fast-slanted.png');
if (fs.existsSync(evalSheet)) fs.copyFileSync(evalSheet, path.join(OUT, 'evaluation.png'));
log('wrote', fs.readdirSync(OUT).join(', '));
