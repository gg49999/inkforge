// Fill-in glyphs: characters the writer never supplied are drawn as pen-stroke
// skeletons and rendered with the writer's own pen — measured stroke width,
// cap/digit height, and a smooth hand wobble — so they sit in the same voice
// as the real letters. Real samples always override fill-ins.

import { UPP, METRICS } from './constants.js';
import { strokesToSample, ellipse as E } from './synth.js';
import { rng, hashString, median } from './raster.js';

const PI = Math.PI;
const L = (...xy) => { const o = []; for (let i = 0; i < xy.length; i += 2) o.push({ x: xy[i], y: xy[i + 1] }); return o; };
const dot = (x, y) => [{ x, y }, { x: x + 3, y: y + 3 }];

// Skeletons in font units: baseline 0, x-height 500, cap height 720, descender ~-220.
// Caps, digits and tall symbols are rescaled to the writer's real cap height.
export const SKELETONS = {
  a: [[...E(210, 250, 170, 240, 20, 0.2 * PI, 2.15 * PI)], L(380, 490, 385, 0)],
  b: [L(70, 790, 70, 0), [...E(230, 250, 165, 245, 20, PI, 3 * PI)]],
  c: [E(230, 250, 180, 245, 18, 0.25 * PI, 1.75 * PI)],
  d: [[...E(200, 250, 165, 245, 20, 0, 2 * PI)], L(370, 790, 370, 0)],
  e: [[...L(50, 260, 400, 260), ...E(225, 250, 175, 245, 22, 0, 1.75 * PI).slice(1)]],
  f: [[...E(310, 650, 120, 140, 10, 0.1 * PI, PI), ...L(190, 0)], L(70, 480, 340, 480)],
  g: [[...E(210, 280, 165, 215, 20, 0.15 * PI, 2.1 * PI)], [...L(375, 480, 375, -80), ...E(220, -80, 155, 140, 12, 0, -PI)]],
  h: [L(70, 790, 70, 0), [...L(70, 360), ...E(230, 340, 160, 160, 14, PI, 0).slice(1), ...L(390, 0)]],
  i: [L(80, 480, 80, 0), dot(85, 660)],
  l: [L(80, 790, 75, 0)],
  m: [L(60, 500, 60, 0), [...L(60, 380), ...E(175, 360, 115, 140, 10, PI, 0).slice(1), ...L(290, 0)], [...L(290, 380), ...E(405, 360, 115, 140, 10, PI, 0).slice(1), ...L(520, 0)]],
  n: [L(60, 500, 60, 0), [...L(60, 380), ...E(220, 360, 160, 140, 16, PI, 0).slice(1), ...L(380, 0)]],
  o: [E(220, 250, 185, 245, 26, 0.5 * PI, 2.55 * PI)],
  p: [L(70, 500, 70, -230), [...E(230, 250, 165, 245, 20, PI, 3 * PI)]],
  r: [L(70, 500, 70, 0), [...L(70, 330), ...E(220, 330, 150, 170, 10, PI, 0.35 * PI).slice(1)]],
  s: [[...E(210, 370, 150, 120, 12, 0.1 * PI, 1.5 * PI), ...E(210, 130, 170, 125, 12, 0.5 * PI, -0.9 * PI)]],
  t: [L(150, 720, 140, 0), L(30, 480, 300, 490)],
  u: [[...L(60, 500, 60, 160), ...E(215, 160, 155, 160, 14, PI, 2 * PI).slice(1)], L(370, 500, 375, 0)],
  w: [L(30, 500, 160, 0, 290, 360, 420, 0, 550, 500)],
  B: [[...L(70, 0, 70, 720, 270, 720), ...E(270, 545, 170, 175, 12, 0.5 * PI, -0.5 * PI), ...L(70, 370, 300, 370), ...E(300, 185, 190, 185, 12, 0.5 * PI, -0.5 * PI), ...L(70, 0)]],
  C: [E(320, 360, 270, 370, 26, 0.25 * PI, 1.75 * PI)],
  D: [[...L(70, 0, 70, 720, 220, 720), ...E(220, 360, 300, 360, 22, 0.5 * PI, -0.5 * PI), ...L(70, 0)]],
  F: [L(440, 720, 70, 720, 70, 0), L(70, 380, 360, 380)],
  I: [L(250, 720, 250, 0), L(110, 720, 390, 720), L(110, 0, 390, 0)],
  L: [L(70, 720, 70, 0, 430, 0)],
  R: [[...L(70, 0, 70, 720, 290, 720), ...E(290, 555, 175, 165, 12, 0.5 * PI, -0.5 * PI), ...L(70, 390)], L(250, 390, 470, 0)],
  S: [[...E(270, 540, 210, 180, 14, 0.12 * PI, 1.5 * PI), ...E(270, 180, 230, 180, 14, 0.5 * PI, -0.88 * PI)]],
  T: [L(30, 720, 530, 720), L(280, 720, 280, 0)],
  U: [[...L(70, 720, 70, 230), ...E(280, 230, 210, 230, 14, PI, 2 * PI).slice(1), ...L(490, 720)]],
  W: [L(30, 720, 180, 0, 330, 540, 480, 0, 630, 720)],
  Y: [L(40, 720, 280, 380, 520, 720), L(280, 380, 280, 0)],
  // Digits are drawn the way a hand moves: one continuous stroke where people
  // write them that way, flags added after, loops that start at the top.
  '0': [E(250, 360, 185, 365, 30, 0.45 * PI, 2.48 * PI)],
  '1': [L(115, 600, 240, 720, 236, 0)],
  '2': [[...E(240, 535, 180, 180, 14, 0.92 * PI, -0.18 * PI), ...L(70, 10, 450, 15)]],
  '4': [L(330, 720, 50, 240, 470, 245), L(355, 470, 360, 0)],
  '6': [[...L(400, 705, 270, 640, 150, 490, 85, 290), ...E(250, 215, 170, 210, 20, PI, 3.05 * PI)]],
  '7': [L(55, 705, 450, 720, 205, 0)],
  '9': [[...E(250, 525, 175, 185, 20, 0.05 * PI, 2.05 * PI)], L(425, 560, 375, 0)],
  '&': [[...L(480, 0, 140, 470), ...E(230, 580, 100, 130, 14, PI * 1.2, -0.2 * PI + 2 * PI * 0 + 2.0 * PI), ...L(130, 200), ...E(240, 170, 180, 170, 14, PI, 1.85 * PI), ...L(490, 330)]],
  j: [L(250, 500, 250, 0, 238, -120, 180, -205, 95, -200, 50, -150), dot(255, 665)],
  x: [L(40, 500, 390, 0), L(390, 500, 40, 0)],
  k: [L(70, 790, 70, 0), L(370, 500, 70, 210), L(170, 290, 400, 0)],
  q: [[...E(220, 250, 180, 240, 20, 0.15 * PI, 2.1 * PI)], L(400, 480, 400, -220)],
  v: [L(30, 500, 210, 0, 390, 500)],
  y: [L(40, 500, 220, 30), L(400, 500, 220, 30, 150, -200)],
  z: [L(50, 500, 380, 500, 40, 0, 400, 0)],
  A: [L(30, 0, 290, 720, 550, 0), L(140, 270, 440, 270)],
  E: [L(430, 720, 70, 720, 70, 0, 440, 0), L(70, 370, 360, 370)],
  G: [[...E(300, 360, 260, 360, 26, 0.3 * PI, 1.95 * PI), ...L(560, 320, 380, 320)]],
  H: [L(60, 720, 60, 0), L(480, 720, 480, 0), L(60, 370, 480, 370)],
  J: [[...L(430, 720, 430, 190), ...E(255, 190, 175, 195, 14, 0, -PI)]],
  K: [L(70, 720, 70, 0), L(450, 720, 70, 290), L(190, 400, 470, 0)],
  M: [L(40, 0, 90, 720, 310, 240, 530, 720, 580, 0)],
  N: [L(60, 0, 60, 720, 470, 0, 470, 720)],
  O: [E(300, 360, 265, 370, 34, 0.5 * PI, 2.55 * PI)],
  P: [[...L(70, 0, 70, 720, 300, 720), ...E(300, 555, 175, 165, 14, 0.5 * PI, -0.5 * PI), ...L(70, 390)]],
  Q: [E(300, 360, 265, 370, 34, 0.5 * PI, 2.55 * PI), L(340, 150, 580, -60)],
  V: [L(30, 720, 280, 0, 530, 720)],
  X: [L(40, 720, 510, 0), L(510, 720, 40, 0)],
  Z: [L(50, 720, 490, 720, 40, 0, 500, 0)],
  '3': [[...E(240, 540, 190, 180, 14, 0.85 * PI, -0.5 * PI), ...E(250, 190, 220, 190, 16, 0.5 * PI, -0.85 * PI)]],
  '5': [[...L(130, 715, 100, 410), ...E(250, 230, 215, 225, 16, 0.78 * PI, -0.85 * PI)], L(135, 718, 440, 728)],
  // One continuous figure-eight (top lobe smaller), like a pen actually draws it.
  '8': [Array.from({ length: 37 }, (_, i) => {
    const t = (i / 36) * 2 * PI, y = 360 + 360 * Math.cos(t);
    return { x: 250 + (y > 360 ? 160 : 200) * Math.sin(2 * t), y };
  })],
  ';': [dot(95, 430), L(100, 60, 95, 0, 60, -110)],
  ':': [dot(90, 430), dot(90, 40)],
  '!': [L(100, 720, 95, 210), dot(95, 30)],
  '?': [[...E(230, 560, 170, 160, 14, 0.85 * PI, -0.4 * PI), ...L(230, 300, 230, 210)], dot(230, 30)],
  "'": [L(100, 720, 92, 560)],
  '"': [L(80, 720, 72, 560), L(190, 720, 182, 560)],
  '(': [E(320, 290, 230, 520, 16, 0.62 * PI, 1.38 * PI)],
  ')': [E(40, 290, 230, 520, 16, 0.38 * PI, -0.38 * PI)],
  '/': [L(40, -120, 400, 760)],
  '\\': [L(40, 760, 400, -120)],
  '@': [[...E(340, 330, 110, 130, 16, 0.1 * PI, 2.1 * PI)], [...L(450, 440, 450, 230, 500, 160, 590, 190, 630, 330), ...E(350, 330, 280, 310, 30, 0, 1.8 * PI)]],
  '#': [L(180, 650, 140, 40), L(380, 650, 340, 40), L(60, 460, 470, 460), L(40, 230, 450, 230)],
  '$': [[...E(250, 520, 170, 145, 14, 0.15 * PI, 1.5 * PI), ...E(250, 220, 185, 150, 14, 0.5 * PI, -0.85 * PI)], L(250, 790, 250, -70)],
  '%': [L(470, 710, 60, 0), E(125, 580, 75, 95, 16, 0, 2 * PI), E(405, 120, 75, 95, 16, 0, 2 * PI)],
  '*': [L(230, 720, 230, 420), L(100, 650, 360, 490), L(360, 650, 100, 490)],
  '+': [L(240, 520, 240, 120), L(60, 320, 420, 320)],
  '=': [L(60, 420, 420, 420), L(60, 220, 420, 220)],
  '_': [L(20, -90, 480, -90)],
  '[': [L(240, 770, 90, 770, 90, -160, 240, -160)],
  ']': [L(60, 770, 210, 770, 210, -160, 60, -160)],
  '{': [L(270, 770, 180, 730, 170, 420, 80, 310, 170, 210, 180, -110, 270, -160)],
  '}': [L(60, 770, 150, 730, 160, 420, 250, 310, 160, 210, 150, -110, 60, -160)],
  '<': [L(420, 560, 60, 320, 420, 80)],
  '>': [L(60, 560, 420, 320, 60, 80)],
  '~': [Array.from({ length: 13 }, (_, i) => ({ x: 40 + i * 35, y: 330 + 60 * Math.sin((i / 12) * 2 * PI) }))],
  '^': [L(60, 460, 230, 720, 400, 460)],
  '|': [L(120, 790, 120, -190)],
  '`': [L(80, 730, 170, 610)],
  '’': [L(115, 720, 112, 640, 75, 560)],
  '“': [L(130, 560, 92, 640, 95, 720), L(240, 560, 202, 640, 205, 720)],
  '”': [L(115, 720, 112, 640, 75, 560), L(225, 720, 222, 640, 185, 560)],
  '—': [L(30, 300, 930, 300)],
  '…': [dot(90, 30), dot(290, 30), dot(490, 30)],
  '-': [L(50, 290, 330, 300)],
  '.': [dot(80, 30)],
  ',': [L(95, 60, 90, 0, 55, -110)],
};

const TALL = /^[A-Z0-9]$/;

/** Stroke width (font units) of a sample: 2 * ink area / boundary length. */
export function strokeUnits(s) {
  let area = 0, edges = 0;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const i = y * s.w + x, on = s.ink[i] > 0.5;
    area += s.ink[i];
    if (x < s.w - 1 && on !== s.ink[i + 1] > 0.5) edges++;
    if (y < s.h - 1 && on !== s.ink[i + s.w] > 0.5) edges++;
  }
  return edges ? ((2 * area) / (edges / (4 / PI))) * UPP : 50;
}

function inkHeight(s) {
  let top = -1, bottom = -1;
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.ink[y * s.w + x] > 0.5) { if (top < 0) top = y; bottom = y; }
  return top < 0 ? 0 : (bottom - top + 1) * UPP;
}

/** Measure the writer's pen and proportions from real samples. */
export function measureHand(samples) {
  const real = samples.filter(s => !s.disabled && s.source !== 'fill-in');
  const widths = real.filter(s => /^[a-z]$/.test(s.char)).map(strokeUnits);
  const caps = real.filter(s => /^[A-Z0-9]$/.test(s.char)).map(inkHeight).filter(Boolean);
  const xs = real.filter(s => /^[acemnorsuvwxz]$/.test(s.char)).map(inkHeight).filter(Boolean);
  const xHeight = median(xs) || METRICS.xHeight;
  return {
    // Area/perimeter underestimates real ballpoint weight on soft photo edges.
    pen: (median(widths) || 38) * 1.3,
    // Few capitals are usually harvested; keep caps clearly taller than lowercase.
    capHeight: Math.max(median(caps) || 0, xHeight * 1.35),
    xHeight,
  };
}

/**
 * Real digits harvested from headings or margins come out at odd sizes. Scale
 * any real digit whose height is off by more than 25% to the hand's digit
 * height (keeping its baseline), so a row of numbers reads as one family.
 */
export function normalizeDigits(samples, hand = measureHand(samples)) {
  const changed = [];
  for (const s of samples) {
    if (s.source === 'fill-in' || !/^[0-9]$/.test(s.char)) continue;
    const h = inkHeight(s);
    if (!h || Math.abs(h / hand.capHeight - 1) <= 0.25) continue;
    const k = hand.capHeight / h;
    const w = Math.max(1, Math.round(s.w * k)), hh = Math.max(1, Math.round(s.h * k));
    const ink = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      const sx = Math.min(s.w - 1, (x + 0.5) / k - 0.5), sy = Math.min(s.h - 1, (y + 0.5) / k - 0.5);
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(s.w - 1, x0 + 1), y1 = Math.min(s.h - 1, y0 + 1), fx = sx - x0, fy = sy - y0;
      const v = (s.ink[y0 * s.w + x0] * (1 - fx) + s.ink[y0 * s.w + x1] * fx) * (1 - fy) + (s.ink[y1 * s.w + x0] * (1 - fx) + s.ink[y1 * s.w + x1] * fx) * fy;
      ink[y * w + x] = v;
    }
    s.w = w; s.h = hh; s.ink = ink; s.baseline *= k;
    changed.push(s.id);
  }
  return changed;
}

/** Smooth hand wobble + small lean, deterministic per character and copy. */
function wobble(strokes, seed, amp, rough = amp * 0.3) {
  const r = rng(seed);
  const waves = Array.from({ length: 3 }, () => ({ f: 0.004 + r() * 0.008, p: r() * 2 * PI, q: r() * 2 * PI }));
  const lean = (r() - 0.5) * 0.06;
  return strokes.map(st => {
    const k = 0.85 + r() * 0.3; // per-stroke pressure
    return st.map((pt, i) => {
      let dx = 0, dy = 0;
      for (const w of waves) { dx += Math.sin(w.f * pt.y + w.p); dy += Math.sin(w.f * pt.x + w.q); }
      // Taper toward stroke ends like a real pen lift.
      const t = st.length > 1 ? i / (st.length - 1) : 0.5;
      const taper = 0.8 + 0.2 * Math.sin(PI * t);
      // Small per-point tremor on top of the smooth wobble: hands aren't plotters.
      const jx = (r() - 0.5) * rough, jy = (r() - 0.5) * rough;
      return { x: pt.x + (dx / 3) * amp + pt.y * lean + jx, y: pt.y + (dy / 3) * amp + jy, wk: k * taper * (0.9 + r() * 0.2) };
    });
  });
}

/**
 * One "copy" of a skeleton as a hand would draw it this time: control points
 * drift along each stroke (low-frequency, so curves stay curves), closed loops
 * overshoot or stop short, and the whole letter gets its own lean, size and
 * width. Every copy is a different drawing, not a transformed duplicate.
 */
function handCopy(skel, seed, { drift = 22, lean = 3, size = 0.05, width = 0.07 } = {}) {
  const r = rng(seed ^ 0x51ED270B);
  const g = () => (r() + r() + r() - 1.5) * 2; // ~N(0,1)
  const leanT = Math.tan((g() * lean * PI) / 180);
  const sz = 1 + g() * size, wd = 1 + g() * width;
  return skel.map(st => {
    let pts = st.slice();
    const n = pts.length;
    if (n < 2) return pts;
    // Loop closure: a closed stroke ends near where it began; vary that.
    const a = pts[0], z = pts[n - 1];
    if (n > 8 && Math.hypot(a.x - z.x, a.y - z.y) < 40) {
      const k = Math.round(g() * n * 0.05);
      if (k < 0) pts = pts.slice(0, Math.max(3, n + k));           // stops short
      else if (k > 0) pts = pts.concat(pts.slice(1, 1 + k));        // overshoots
    }
    // Drift: two random low-frequency waves along the stroke parameter.
    const ph = [r() * 2 * PI, r() * 2 * PI, r() * 2 * PI, r() * 2 * PI];
    const ax = g() * drift, ay = g() * drift, bx = g() * drift * 0.5, by = g() * drift * 0.5;
    return pts.map((p, i) => {
      const t = pts.length > 1 ? i / (pts.length - 1) : 0;
      const dx = ax * Math.sin(PI * t + ph[0]) + bx * Math.sin(3 * PI * t + ph[1]);
      const dy = ay * Math.sin(PI * t + ph[2]) + by * Math.sin(3 * PI * t + ph[3]);
      return { x: (p.x + dx) * sz * wd + p.y * leanT, y: (p.y + dy) * sz };
    });
  });
}

/**
 * Make fill-in samples for every character in `chars` that has no real sample.
 * hand: from measureHand(). Returns samples with source 'fill-in'.
 */
export function makeFillIns(chars, existing, { hand = measureHand(existing), copies = 4, digitCopies = 12, wobbleAmp = 16 } = {}) {
  const realCount = new Map();
  for (const s of existing) if (!s.disabled && s.source !== 'fill-in') realCount.set(s.char, (realCount.get(s.char) || 0) + 1);
  const out = [];
  for (const ch of chars) {
    const have = realCount.get(ch) || 0;
    // Letters/symbols: only fill what's missing. Digits: also top up when there are
    // fewer than 3 real copies (the font mixes them in after the real ones).
    if (!SKELETONS[ch] || (have && !(/^[0-9]$/.test(ch) && have < 3))) continue;
    const tall = TALL.test(ch);
    const sy = tall ? hand.capHeight / 720 : hand.xHeight / 500;
    const n = /^[0-9]$/.test(ch) ? digitCopies : /^[A-Za-z]$/.test(ch) ? copies : 2;
    for (let c = 0; c < n; c++) {
      const seed = hashString('fill:' + ch) ^ Math.imul(c + 1, 0x9E3779B1);
      const scaled = SKELETONS[ch].map(st => st.map(p => ({ x: p.x * (tall ? sy : 1), y: p.y * sy })));
      const drawn = handCopy(scaled, seed);
      const strokes = wobble(drawn, seed, wobbleAmp).map(st => st.map(p => ({ x: p.x, y: p.y, w: hand.pen * p.wk })));
      const s = strokesToSample(ch, strokes, { penWidth: hand.pen, source: 'fill-in', id: `fill-${ch.codePointAt(0)}-${c}` });
      s.created = Date.now() + c;
      out.push(s);
    }
  }
  return out;
}
