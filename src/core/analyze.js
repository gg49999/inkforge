// Handwriting analysis: reads a page of ink and measures the writer.
//
// Measures: page skew, dominant slant and its spread, stroke width and its
// spread (pen pressure), x-height, ascender/descender proportions, baseline
// drift and bounce, letter-size consistency, letter and word spacing (and their
// spread), connectedness (print vs cursive). Also segments lines into glyph
// candidates that can be labeled and turned into font samples.

import { UPP, METRICS } from './constants.js';
import { field, threshold, components, edt, sample, median, mean, std, quantile, rng } from './raster.js';
import { lineChars, alignLine, alignLines, cutLetters } from './align.js';

const DEG = Math.PI / 180;

/** Pick up to n ink pixel coordinates (deterministic subsample). */
function inkPixels(m, n = 60000, filter = null) {
  const pts = [];
  const { w, h, data } = m;
  let total = 0;
  for (let i = 0; i < data.length; i++) if (data[i]) total++;
  const keep = Math.min(1, n / Math.max(1, total));
  const r = rng(7);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[y * w + x] && (keep >= 1 || r() < keep) && (!filter || filter(x, y))) pts.push(x, y);
  }
  return pts;
}

/** Projection sharpness: sum of squared bin counts. */
function sharpness(values, bin, lo, hi) {
  const nb = Math.ceil((hi - lo) / bin) + 1;
  const h = new Float64Array(nb);
  for (const v of values) { const k = Math.floor((v - lo) / bin); if (k >= 0 && k < nb) h[k]++; }
  let s = 0; for (const c of h) s += c * c;
  return s;
}

/** Page skew (deg): rotation that makes horizontal projection sharpest. */
export function estimateSkew(m) {
  const pts = inkPixels(m, 40000);
  let best = 0, bestS = -1;
  for (let a = -10; a <= 10.001; a += 0.5) {
    const t = Math.tan(a * DEG);
    const ys = [];
    for (let i = 0; i < pts.length; i += 2) ys.push(pts[i + 1] - pts[i] * t);
    const s = sharpness(ys, 2, -m.w * 0.2 - 10, m.h + m.w * 0.2 + 10);
    if (s > bestS) { bestS = s; best = a; }
  }
  return best;
}

/** Rotate a field by deg about its center (bilinear). */
export function rotateField(f, deg) {
  if (Math.abs(deg) < 0.05) return f;
  const a = deg * DEG, c = Math.cos(a), s = Math.sin(a);
  const cx = f.w / 2, cy = f.h / 2;
  const out = new Float32Array(f.w * f.h);
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    const dx = x - cx, dy = y - cy;
    const sx = cx + dx * c - dy * s, sy = cy + dx * s + dy * c;
    out[y * f.w + x] = sx < 0 || sy < 0 || sx > f.w - 1 || sy > f.h - 1 ? 0 : sample(f, sx, sy);
  }
  return field(f.w, f.h, out);
}

/**
 * Vinciarelli-style slant score per angle: shear the ink, then reward columns
 * whose ink is one unbroken vertical run (a stem), by run length squared.
 * pts = flat [x, y, ...] of ALL ink pixels in the region (not subsampled).
 * Returns Float64Array of scores for angles -range..range step `step`.
 */
function slantScores(pts, { step = 1, range = 45, minRun = 4 } = {}) {
  const nA = Math.round((2 * range) / step) + 1;
  const scores = new Float64Array(nA);
  if (pts.length < 40) return scores;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i]; if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1]; if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  const span = maxY - minY, off = Math.ceil(span * Math.tan(range * DEG)) + 2;
  const W = Math.ceil(maxX - minX) + 2 * off + 3;
  const lo = new Int32Array(W), hi = new Int32Array(W), cnt = new Int32Array(W);
  for (let a = 0; a < nA; a++) {
    const t = Math.tan((-range + a * step) * DEG);
    lo.fill(1 << 30); hi.fill(-1); cnt.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const y = pts[i + 1] - minY;
      const c = Math.round(pts[i] - minX + (y - span) * t) + off;
      if (c < 0 || c >= W) continue;
      cnt[c]++; if (y < lo[c]) lo[c] = y; if (y > hi[c]) hi[c] = y;
    }
    let s = 0;
    for (let c = 0; c < W; c++) {
      if (!cnt[c]) continue;
      const run = hi[c] - lo[c] + 1;
      if (run >= minRun && cnt[c] >= run * 0.9) s += run * run;
    }
    scores[a] = s;
  }
  return scores;
}

function argmaxAngle(scores, step = 1, range = 45) {
  let bi = -1, bv = 0;
  for (let i = 0; i < scores.length; i++) if (scores[i] > bv) { bv = scores[i]; bi = i; }
  if (bi < 0) return null;
  // Parabolic refinement.
  if (bi > 0 && bi < scores.length - 1) {
    const a = scores[bi - 1], b = scores[bi], c = scores[bi + 1];
    const d = a - 2 * b + c;
    if (d < 0) return -range + (bi + 0.5 * (a - c) / d) * step;
  }
  return -range + bi * step;
}

/** Dominant slant (deg, + = leaning right) of a set of ink points. */
function slantOf(pts, step = 1, range = 45, minRun = 4) {
  return argmaxAngle(slantScores(pts, { step, range, minRun }), step, range);
}

/**
 * Stroke width (px). Primary estimate: 2 * ink area / boundary length, which is
 * exact for long strokes and keeps sub-pixel precision via soft coverage.
 * Spread (pressure variation) comes from the distance-transform ridge values.
 */
function strokeStats(m, ink) {
  const { w, h } = m;
  let area = 0, edges = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    area += ink.data[i];
    if (x < w - 1 && m.data[i] !== m.data[i + 1]) edges++;
    if (y < h - 1 && m.data[i] !== m.data[i + w]) edges++;
  }
  // Pixel-edge boundaries overestimate curve length by ~4/pi on average.
  const width = edges ? (2 * area) / (edges / (4 / Math.PI)) : 2;
  const ridge = ridgeStats(m);
  return { width, spread: ridge.spread };
}

function ridgeStats(m) {
  const d = edt(m);
  const { w, h } = m;
  const vals = [];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, v = d.data[i];
    if (v < 1) continue;
    // Ridge: not smaller than any 8-neighbour and strictly larger than at least two.
    let ok = true, gt = 0;
    for (let dy = -1; dy <= 1 && ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const u = d.data[i + dy * w + dx];
      if (u > v) { ok = false; break; }
      if (u < v) gt++;
    }
    if (ok && gt >= 2) vals.push(v);
  }
  const widths = vals.map(v => 2 * v - 1).filter(v => v > 0);
  return { width: median(widths) || 2, spread: widths.length ? std(widths) / Math.max(1, median(widths)) : 0 };
}

/** Smooth a 1-D array with a box filter of radius r. */
function smooth1(a, r) {
  const out = new Float64Array(a.length);
  let s = 0;
  const n = a.length;
  for (let i = -r; i < n + r; i++) {
    if (i + r < n) s += a[i + r] || 0;
    if (i - r - 1 >= 0) s -= a[i - r - 1];
    if (i >= 0 && i < n) out[i] = s / (2 * r + 1);
  }
  return out;
}

/** Split a page into text lines using a smoothed horizontal projection. */
function findLines(m, comps, approxH) {
  const prof = new Float64Array(m.h);
  for (let y = 0; y < m.h; y++) { let c = 0; for (let x = 0; x < m.w; x++) c += m.data[y * m.w + x]; prof[y] = c; }
  const sm = smooth1(prof, Math.max(2, Math.round(approxH / 5)));
  let mx = 0; for (const v of sm) if (v > mx) mx = v;
  // Peaks = rows that are the maximum within +-0.55 line heights. Works for
  // short lines too, since each peak only competes with its neighbourhood.
  const win = Math.max(3, Math.round(approxH * 0.55));
  let peaks = [];
  for (let y = 0; y < m.h; y++) {
    const v = sm[y];
    if (v < mx * 0.03) continue;
    let isMax = true;
    for (let k = Math.max(0, y - win); k <= Math.min(m.h - 1, y + win) && isMax; k++) if (sm[k] > v || (sm[k] === v && k < y)) isMax = false;
    if (isMax) peaks.push(y);
  }
  // A peak must stand out from the valleys on both sides (else it's an ascender bump).
  const valley = (a, b) => { let mv = Infinity, my = a; for (let y = a; y <= b; y++) if (sm[y] < mv) { mv = sm[y]; my = y; } return { mv, my }; };
  let changed = true;
  while (changed && peaks.length > 1) {
    changed = false;
    for (let i = 0; i < peaks.length; i++) {
      const l = i > 0 ? valley(peaks[i - 1], peaks[i]).mv : 0;
      const r = i < peaks.length - 1 ? valley(peaks[i], peaks[i + 1]).mv : 0;
      const v = sm[peaks[i]];
      if (v - Math.max(l, r) < v * 0.35) {
        // Merge into the stronger neighbour.
        peaks.splice(i, 1); changed = true; break;
      }
    }
  }
  const bounds = [0];
  for (let i = 1; i < peaks.length; i++) bounds.push(valley(peaks[i - 1], peaks[i]).my);
  bounds.push(m.h);
  const lines = peaks.map((p, i) => {
    // Core = contiguous run around the peak above 30% of the peak.
    let a = p, b = p;
    while (a > bounds[i] && sm[a - 1] >= sm[p] * 0.3) a--;
    while (b < bounds[i + 1] - 1 && sm[b + 1] >= sm[p] * 0.3) b++;
    return { y0: bounds[i], y1: bounds[i + 1], core: [a, b], comps: [] };
  });
  for (const comp of comps) {
    let li = lines.findIndex(l => comp.cy >= l.y0 && comp.cy < l.y1);
    if (li < 0) continue;
    // Dots / accents floating above the core belong to the nearest line by core distance.
    const l = lines[li];
    if (comp.y1 < l.core[0] && li > 0) {
      const above = lines[li - 1];
      if (comp.y0 - above.core[1] < l.core[0] - comp.y1 && comp.area < approxH * approxH * 0.05) li--;
    }
    lines[li].comps.push(comp);
  }
  return lines.filter(l => l.comps.length);
}

/** 2-means split of a 1-D sample; returns { lo:[], hi:[], cut } or null. */
function split2(vals) {
  if (vals.length < 4) return null;
  const s = vals.slice().sort((a, b) => a - b);
  let best = null;
  for (let i = 1; i < s.length; i++) {
    const a = s.slice(0, i), b = s.slice(i);
    const ma = mean(a), mb = mean(b);
    const cost = a.reduce((t, v) => t + (v - ma) ** 2, 0) + b.reduce((t, v) => t + (v - mb) ** 2, 0);
    if (!best || cost < best.cost) best = { cost, cut: (s[i - 1] + s[i]) / 2, lo: a, hi: b, ma, mb };
  }
  return best;
}

/**
 * Analyze an ink field (1 = ink). Options:
 *   transcription: optional text written on the page (used to label glyphs)
 * Returns a full report plus `candidates` for glyph extraction.
 */
export function analyzeInk(ink0, { transcription = '' } = {}) {
  let m0 = threshold(ink0, 0.5);
  const skew = estimateSkew(m0);
  const ink = rotateField(ink0, skew);
  const m = threshold(ink, 0.5);
  const { labels, comps: rawComps } = components(m, { minArea: 1 });
  const totalInk = rawComps.reduce((s, c) => s + c.area, 0);
  if (!totalInk) throw new Error('No handwriting found in the image.');
  const big = rawComps.filter(c => c.area >= 6);
  const heights = big.map(c => c.y1 - c.y0 + 1);
  const approxH = Math.max(6, quantile(heights, 0.6));
  const comps = rawComps.filter(c => c.area >= Math.max(4, approxH * approxH * 0.004));

  const stroke = strokeStats(m, ink);
  const lines = findLines(m, comps, approxH);
  if (!lines.length) throw new Error('Could not find any lines of writing.');

  // --- slant (global, then per letter-ish component)
  const compPixels = (c) => {
    const pts = [];
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (labels[y * m.w + x] === c.id) pts.push(x, y);
    return pts;
  };
  const minRun = Math.max(4, Math.round(approxH * 0.3));
  const total = new Float64Array(91);
  for (const line of lines) {
    const pts = line.comps.flatMap(compPixels);
    const sc = slantScores(pts, { minRun });
    for (let i = 0; i < 91; i++) total[i] += sc[i];
  }
  const slant = argmaxAngle(total) ?? 0;
  // Per-letter slant from letters with a clear stem (ascenders / descenders).
  const slants = [];
  for (const c of comps) {
    const h = c.y1 - c.y0 + 1;
    if (h < approxH * 1.15 || c.area < 30) continue;
    const s = slantOf(compPixels(c), 1, 40, Math.round(h * 0.45));
    if (s != null) slants.push(s);
  }
  const slantMed = median(slants);
  const slantSpread = slants.length >= 3 ? 1.4826 * median(slants.map(s => Math.abs(s - slantMed))) : 0;

  // --- per line metrics
  const tanS = Math.tan(slant * DEG);
  const lineReports = [];
  for (const line of lines) {
    const prof = new Float64Array(line.y1 - line.y0);
    for (const c of line.comps) {
      for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) {
        if (labels[y * m.w + x] === c.id && y >= line.y0 && y < line.y1) prof[y - line.y0]++;
      }
    }
    const sm = smooth1(prof, Math.max(1, Math.round(stroke.width / 2)));
    let peak = 0, pi = 0;
    sm.forEach((v, i) => { if (v > peak) { peak = v; pi = i; } });
    let a = pi, b = pi;
    while (a > 0 && sm[a - 1] >= peak * 0.38) a--;
    while (b < sm.length - 1 && sm[b + 1] >= peak * 0.38) b++;
    const xTop = line.y0 + a, baseline = line.y0 + b + 1;
    const xh = Math.max(3, baseline - xTop);

    // Baseline fit using bottoms of non-descending components.
    const feet = line.comps.filter(c => c.y1 > baseline - xh * 0.35 && c.y1 < baseline + xh * 0.3 && c.y1 - c.y0 > xh * 0.4);
    let slope = 0, icpt = baseline, resid = [];
    if (feet.length >= 3) {
      const xs = feet.map(c => (c.x0 + c.x1) / 2), ys = feet.map(c => c.y1 + 1);
      const mx = mean(xs), my = mean(ys);
      let sxx = 0, sxy = 0;
      xs.forEach((x, i) => { sxx += (x - mx) ** 2; sxy += (x - mx) * (ys[i] - my); });
      slope = sxx ? sxy / sxx : 0;
      icpt = my - slope * mx;
      resid = xs.map((x, i) => ys[i] - (icpt + slope * x));
    }
    const baseAt = x => icpt + slope * x;

    // Glyph candidates: merge components that overlap after removing slant.
    const items = line.comps.map(c => {
      const b0 = baseAt((c.x0 + c.x1) / 2);
      return { comps: [c], x0: c.x0 + (c.y1 - b0) * tanS, x1: c.x1 + (c.y0 - b0) * tanS, rx0: c.x0, rx1: c.x1, y0: c.y0, y1: c.y1, area: c.area };
    }).map(it => ({ ...it, x0: Math.min(it.x0, it.x1), x1: Math.max(it.x0, it.x1) })).sort((p, q) => p.x0 - q.x0);
    const boxes = [];
    for (const it of items) {
      const last = boxes[boxes.length - 1];
      if (last) {
        const ov = Math.min(last.x1, it.x1) - Math.max(last.x0, it.x0);
        const wmin = Math.min(last.x1 - last.x0, it.x1 - it.x0) + 1;
        const small = it.area < xh * xh * 0.12 || last.area < xh * xh * 0.12;
        if (ov > wmin * 0.45 || (small && ov > -stroke.width)) {
          last.comps.push(...it.comps);
          last.x0 = Math.min(last.x0, it.x0); last.x1 = Math.max(last.x1, it.x1);
          last.rx0 = Math.min(last.rx0, it.rx0); last.rx1 = Math.max(last.rx1, it.rx1);
          last.y0 = Math.min(last.y0, it.y0); last.y1 = Math.max(last.y1, it.y1); last.area += it.area;
          continue;
        }
      }
      boxes.push({ ...it, comps: [...it.comps] });
    }
    const gaps = [];
    for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].x0 - boxes[i - 1].x1);
    // Letter-sized boxes (x-height only) for size consistency.
    const xOnly = boxes.filter(bx => bx.y0 > xTop - xh * 0.35 && bx.y1 < baseline + xh * 0.3 && bx.y1 - bx.y0 > xh * 0.5);
    lineReports.push({
      y0: line.y0, y1: line.y1, xTop, baseline, xHeight: xh, slope, icpt,
      ascTop: Math.min(...line.comps.map(c => c.y0)), descBottom: Math.max(...line.comps.map(c => c.y1)),
      baselineResid: resid, boxes, gaps, sizes: xOnly.map(bx => bx.y1 - bx.y0 + 1),
      widths: boxes.map(bx => bx.x1 - bx.x0 + 1),
    });
  }

  const xHeight = median(lineReports.map(l => l.xHeight));
  // Ascender/descender: robust tall/deep extents relative to each line.
  const asc = [], desc = [];
  for (const l of lineReports) for (const bx of l.boxes) {
    const up = l.baseline - bx.y0, down = bx.y1 + 1 - l.baseline;
    if (up > l.xHeight * 1.3) asc.push(up / l.xHeight);
    if (down > l.xHeight * 0.3) desc.push(down / l.xHeight);
  }
  // Gaps beyond a few x-heights are layout (margins, numbering), not spacing.
  const allGaps = lineReports.flatMap(l => l.gaps.filter(g => g < l.xHeight * 3.5));
  const sp = split2(allGaps.map(g => Math.log(Math.max(1, g + stroke.width))));
  let letterGaps = allGaps, wordGaps = [];
  const spaces = (transcription.match(/ +/g) || []).length;
  if (sp) {
    const cut = Math.exp(sp.cut) - stroke.width;
    const lo = allGaps.filter(g => g <= cut), hi = allGaps.filter(g => g > cut);
    if (hi.length && (spaces > 0 || median(hi) > median(lo) * 2 + stroke.width)) { letterGaps = lo; wordGaps = hi; }
  }
  const widths = lineReports.flatMap(l => l.widths);
  const sizes = lineReports.flatMap(l => l.sizes);
  const resid = lineReports.flatMap(l => l.baselineResid);
  const lineAngles = lineReports.map(l => Math.atan(l.slope) / DEG);

  const connected = median(widths) / Math.max(1, xHeight);
  const report = {
    image: { w: ink0.w, h: ink0.h },
    skew,
    slant,
    slantSpread,
    strokeWidth: stroke.width,
    pressureVariation: stroke.spread,
    xHeight,
    ascenderRatio: asc.length ? median(asc) : 1.6,
    descenderRatio: desc.length ? median(desc) : 0.6,
    baselineDrift: lineAngles.length ? mean(lineAngles.map(Math.abs)) : 0,
    baselineBounce: resid.length ? std(resid) : 0,
    sizeVariation: sizes.length >= 3 ? std(sizes) / Math.max(1, mean(sizes)) : 0,
    letterGap: median(letterGaps),
    letterGapSpread: letterGaps.length >= 3 ? std(letterGaps) : 0,
    wordGap: wordGaps.length ? median(wordGaps) : null,
    connectedness: connected,
    style: connected > 2.2 ? 'cursive' : connected > 1.2 ? 'mixed' : 'print',
    lines: lineReports.map(l => ({ y0: l.y0, y1: l.y1, xTop: l.xTop, baseline: l.baseline, xHeight: l.xHeight, slope: l.slope, icpt: l.icpt, ascTop: l.ascTop, descBottom: l.descBottom, boxCount: l.boxes.length })),
    inkField: ink, labels, lineReports,
  };
  report.candidates = extractCandidates(report, transcription);
  report.suggested = suggestSettings(report);
  return report;
}

/** Map measured style (pixels) onto font settings (font units). */
export function suggestSettings(r) {
  const k = METRICS.xHeight / Math.max(1, r.xHeight); // px -> units
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const spacing = clamp(Math.round((r.letterGap * k) / 2), 10, 160);
  return {
    spacing,
    wordSpace: r.wordGap ? clamp(Math.round(r.wordGap * k - 2 * spacing), 150, 700) : 300,
    vary: {
      angle: +clamp(r.slantSpread * 0.6, 0.4, 5).toFixed(2),
      baseline: Math.round(clamp(r.baselineBounce * k * 0.8, 3, 60)),
      scale: +clamp(r.sizeVariation * 0.7, 0.01, 0.12).toFixed(3),
      spacing: Math.round(clamp(r.letterGapSpread * k * 0.5, 4, 60)),
      wobble: Math.round(clamp(4 + r.pressureVariation * 20, 3, 14)),
    },
    strokeUnits: Math.round(r.strokeWidth * k),
    ascender: Math.round(METRICS.xHeight * r.ascenderRatio),
    descender: -Math.round(METRICS.xHeight * r.descenderRatio),
  };
}

/**
 * Turn glyph candidate boxes into normalized samples, labeled from the
 * transcription when the counts line up (per line, ignoring spaces).
 */
export function extractCandidates(r, transcription = '') {
  if (transcription.trim()) return alignedCandidates(r, transcription);
  const textLines = transcription.split(/\r?\n/).map(s => [...s.replace(/\s+/g, '')]).filter(a => a.length);
  const out = [];
  const { inkField: f, labels } = r;
  r.lineReports.forEach((l, li) => {
    const chars = textLines[li] || [];
    const exact = chars.length === l.boxes.length;
    l.boxes.forEach((bx, bi) => {
      const ids = new Set(bx.comps.map(c => c.id));
      const pad = 3;
      const x0 = Math.max(0, bx.rx0 - pad), x1 = Math.min(f.w - 1, bx.rx1 + pad);
      const y0 = Math.max(0, bx.y0 - pad), y1 = Math.min(f.h - 1, bx.y1 + pad);
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      const crop = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
        const gx = x + x0, gy = y + y0, i = gy * f.w + gx;
        let mine = ids.has(labels[i]);
        if (!mine && !labels[i]) {
          for (let dy = -1; dy <= 1 && !mine; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = gx + dx, yy = gy + dy;
            if (xx >= 0 && yy >= 0 && xx < f.w && yy < f.h && ids.has(labels[yy * f.w + xx])) { mine = true; break; }
          }
        }
        if (mine) crop[y * cw + x] = f.data[i];
      }
      const base = l.icpt + l.slope * ((bx.rx0 + bx.rx1) / 2);
      out.push({
        line: li, index: bi, label: exact ? chars[bi] : (chars[bi] || ''), confident: exact,
        box: { x0, y0, x1, y1 }, crop: { w: cw, h: ch, data: crop }, baselineInCrop: base - y0, xHeight: l.xHeight,
      });
    });
  });
  return out;
}

/**
 * Transcription-driven extraction: page-level line matching, then per-line
 * forced alignment that splits joined letters. Every candidate gets a label
 * and a quality score; `confident` marks the ones worth auto-adding.
 */
function alignedCandidates(r, transcription) {
  const texts = transcription.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const textLines = texts.map(t => { const chars = lineChars(t); return { text: t, chars, expW: chars.reduce((s, c) => s + c.w, 0) }; });
  const lineInfos = r.lineReports.map(l => ({ inkW: l.boxes.reduce((s, b) => s + (b.x1 - b.x0 + 1), 0) / Math.max(1, l.xHeight) }));
  const map = alignLines(lineInfos, textLines);
  const tanS = Math.tan(r.slant * DEG);
  const gapCut = r.wordGap ? Math.sqrt(Math.max(1, r.letterGap) * r.wordGap) : r.xHeight * 0.45;
  const out = [];
  map.forEach((li, ti) => {
    if (li < 0) return;
    const line = r.lineReports[li];
    const chars = textLines[ti].chars;
    const al = alignLine(line.boxes, chars, line.xHeight, gapCut);
    const letters = cutLetters({ f: r.inkField, labels: r.labels, tanS, line }, line.boxes, chars, al);
    letters.forEach((c, k) => out.push({ ...c, line: li, textLine: ti, index: k, confident: c.quality > 0.55 }));
  });
  r.lineMap = map;
  return out;
}

/** Normalize a candidate crop to sample scale (x-height -> METRICS.xHeight units). */
export function candidateToSample(c, char, { resizeFn }) {
  const s = (METRICS.xHeight / UPP) / Math.max(1, c.xHeight);
  const w = Math.max(1, Math.round(c.crop.w * s)), h = Math.max(1, Math.round(c.crop.h * s));
  const r = resizeFn(field(c.crop.w, c.crop.h, c.crop.data), w, h);
  const sample = {
    id: `free-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    char, w: r.w, h: r.h, ink: r.data, baseline: c.baselineInCrop * s, source: 'freeform', created: Date.now(),
  };
  seatOnBaseline(sample);
  return sample;
}

const SITS_ON_BASELINE = /^[abcdefhiklmnorstuvwxzA-Z0-9!?&]$/;
/**
 * Letters that never descend should rest on the baseline. When the page's
 * baseline estimate is clearly wrong for one cut (> 30% of x-height off),
 * re-seat it; smaller offsets are the writer's natural bounce and are kept.
 */
export function seatOnBaseline(s) {
  if (/^[gpqyj]$/.test(s.char)) {
    // Descenders: the bowl's top should meet the x-height line.
    let top = -1;
    for (let y = 0; y < s.h && top < 0; y++) for (let x = 0; x < s.w; x++) if (s.ink[y * s.w + x] > 0.5) { top = y; break; }
    if (top < 0 || s.char === 'j') return s; // j's dot makes "top" ambiguous
    const xhPx = METRICS.xHeight / UPP;
    if (Math.abs(s.baseline - xhPx - top) > xhPx * 0.35) s.baseline = top + xhPx;
    return s;
  }
  if (!SITS_ON_BASELINE.test(s.char)) return s;
  let bottom = -1;
  for (let y = s.h - 1; y >= 0; y--) { let any = false; for (let x = 0; x < s.w; x++) if (s.ink[y * s.w + x] > 0.5) { any = true; break; } if (any) { bottom = y; break; } }
  if (bottom < 0) return s;
  const xhPx = METRICS.xHeight / UPP;
  if (Math.abs(bottom + 1 - s.baseline) > xhPx * 0.3) s.baseline = bottom + 1;
  return s;
}
