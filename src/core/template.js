// Printable capture sheets and the photo/scan reader for them.
//
// Each sheet has four solid corner fiducials and a 6-bit page code (5 bits of
// page number + even parity) printed as small squares. Guide lines and labels
// are printed in pale colours that the ink extractor discards. A photo of a
// filled sheet is located via the fiducials, rectified with a homography, and
// every cell is resampled straight into normalized sample space.

import { CELL, UPP, LOWER, UPPER, DIGITS, DEFAULT_LIGATURES } from './constants.js';
import { field, sample, inkFromLuminance, inkFromPaper, threshold, components, despeckle, bbox, crop, resize, quantile } from './raster.js';

export const COLS = 8, ROWS = 11;
const GW = COLS * CELL.w, GH = ROWS * CELL.h;
const FID = 600;           // fiducial side
const FID_OFF = 500;       // fiducial center distance outside the grid
const BIT = 300, BIT_PITCH = 450, BITS = 6;

const PUNCT_A = [...`.,;:!?'"-()&/@#$`];
const PUNCT_B = [...`%*+=_[]<>~^{}|\\\``, '’', '“', '”', '—', '…'];

export const PAGES = [
  { title: 'Lowercase × 3 + pairs', cells: [...LOWER, ...LOWER, ...LOWER, ...DEFAULT_LIGATURES] },
  { title: 'Capitals, digits, punctuation', cells: [...UPPER, ...UPPER, ...DIGITS, ...DIGITS, ...PUNCT_A] },
  { title: 'Symbols, extra variants, words', cells: [...PUNCT_B, ...DIGITS, ...LOWER, ...'etaoinshrdl', 'the', 'ing', 'and', 'er', 'an', 're', 'on', 'in', ...'TIASMCBPHWRE'] },
];

/** How many samples of each kind of character a good font wants. */
export function wantedCount(ch) {
  if (LOWER.includes(ch) || DIGITS.includes(ch)) return 3;
  if (UPPER.includes(ch)) return 2;
  return 1;
}

/**
 * Build gap-filler sheets from current coverage (Map char -> sample count).
 * Each missing or thin character gets the boxes it still needs; missing ones
 * come before thin ones, lowercase and digits before capitals before symbols.
 * Returns [{ index, title, cells }] with page codes starting at `startIndex`.
 */
export function gapSheets(counts, charset, { startIndex = PAGES.length } = {}) {
  const rank = ch => (LOWER.includes(ch) ? 0 : DIGITS.includes(ch) ? 1 : UPPER.includes(ch) ? 2 : 3);
  const needs = [];
  for (const ch of charset) {
    const have = counts.get(ch) || 0, want = wantedCount(ch);
    if (have < want) needs.push({ ch, n: want - have, missing: have === 0 });
  }
  needs.sort((a, b) => (b.missing - a.missing) || rank(a.ch) - rank(b.ch) || charset.indexOf(a.ch) - charset.indexOf(b.ch));
  const cells = needs.flatMap(x => Array(x.n).fill(x.ch));
  const per = COLS * ROWS, sheets = [];
  for (let i = 0; i < cells.length && startIndex + sheets.length < 31; i += per) {
    const part = cells.slice(i, i + per);
    sheets.push({ index: startIndex + sheets.length, title: `Gap filler ${sheets.length + 1}: ${[...new Set(part)].length} characters`, cells: part });
  }
  return sheets;
}

export function cellRect(i) {
  const col = i % COLS, row = Math.floor(i / COLS);
  return { x: col * CELL.w, y: row * CELL.h, w: CELL.w, h: CELL.h };
}

function pageBits(page) {
  const bits = [];
  for (let k = 0; k < 5; k++) bits.push((page >> k) & 1);
  bits.push(bits.reduce((a, b) => a ^ b, 0));
  return bits;
}

function bitCenter(k) { return { x: GW / 2 + (k - (BITS - 1) / 2) * BIT_PITCH, y: -FID_OFF }; }

export const FIDUCIALS = [
  { x: -FID_OFF, y: -FID_OFF }, { x: GW + FID_OFF, y: -FID_OFF },
  { x: GW + FID_OFF, y: GH + FID_OFF }, { x: -FID_OFF, y: GH + FID_OFF },
];

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** SVG for one printable sheet (scales to any paper size). */
export function templateSVG(pageIndex, { cells = PAGES[pageIndex]?.cells || [], title = PAGES[pageIndex]?.title || '' } = {}) {
  const pad = 900;
  const vb = `${-pad} ${-pad} ${GW + 2 * pad} ${GH + 2 * pad}`;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" preserveAspectRatio="xMidYMid meet">`,
    `<rect x="${-pad}" y="${-pad}" width="${GW + 2 * pad}" height="${GH + 2 * pad}" fill="#fff"/>`];
  for (const f of FIDUCIALS) parts.push(`<rect x="${f.x - FID / 2}" y="${f.y - FID / 2}" width="${FID}" height="${FID}" fill="#000"/>`);
  pageBits(pageIndex).forEach((b, k) => {
    const c = bitCenter(k);
    parts.push(`<rect x="${c.x - BIT / 2}" y="${c.y - BIT / 2}" width="${BIT}" height="${BIT}" fill="${b ? '#000' : '#fff'}" stroke="#e4e4e4" stroke-width="12"/>`);
  });
  // Text stays clear of the page-code squares (x ~ 4900..7500, y -650..-170).
  parts.push(`<text x="0" y="${-FID_OFF + 90}" font-family="Helvetica,Arial,sans-serif" font-size="240" fill="#b8b8b8">Inkforge · sheet ${pageIndex + 1}</text>`);
  const shortTitle = title.length > 52 ? title.slice(0, 51) + '…' : title;
  parts.push(`<text x="0" y="-60" font-family="Helvetica,Arial,sans-serif" font-size="150" fill="#bdbdbd">${esc(shortTitle)}</text>`);
  parts.push(`<text x="${GW}" y="-60" text-anchor="end" font-family="Helvetica,Arial,sans-serif" font-size="150" fill="#c4c4c4">write inside the boxes • sit letters on the blue line</text>`);
  cells.forEach((ch, i) => {
    const r = cellRect(i);
    parts.push(`<g transform="translate(${r.x},${r.y})">`);
    parts.push(`<rect x="0" y="0" width="${CELL.w}" height="${CELL.h}" fill="none" stroke="#dedede" stroke-width="10"/>`);
    const line = (y, color, dash, sw = 8) => parts.push(`<line x1="40" x2="${CELL.w - 40}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`);
    line(CELL.ascLine, '#d6e4f8', '40 40');
    line(CELL.xLine, '#c4d9f7', '60 30');
    line(CELL.baseLine, '#a9c8f3', '', 14);
    line(CELL.descLine, '#d6e4f8', '40 40');
    parts.push(`<text x="70" y="190" font-family="Helvetica,Arial,sans-serif" font-size="170" fill="#c6c6c6">${esc(ch)}</text>`);
    parts.push('</g>');
  });
  parts.push('</svg>');
  return parts.join('');
}

// ------------------------------------------------------------- geometry ---

/** Solve A x = b (n x n) by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    if (Math.abs(A[i][i]) < 1e-12) throw new Error('degenerate homography');
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
    x[i] = s / A[i][i];
  }
  return x;
}

/** Homography mapping src[i] -> dst[i] (4 point pairs). Returns a mapper fn. */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return (x, y) => {
    const w = h[6] * x + h[7] * y + 1;
    return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
  };
}

// ---------------------------------------------------------------- reader ---

/** Find the four corner fiducials in a (downscaled) luminance field. */
export function findFiducials(lum) {
  const ink = inkFromLuminance(lum, { window: Math.max(31, Math.round(Math.min(lum.w, lum.h) / 6)) | 1, k: 0.2 });
  const m = threshold(ink, 0.5);
  const N = lum.w * lum.h;
  const { comps } = components(m, { minArea: Math.max(20, N * 0.00015) });
  const cands = comps.filter(c => {
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const ar = bw / bh, fill = c.area / (bw * bh);
    return ar > 0.55 && ar < 1.8 && fill > 0.6 && c.area < N * 0.02;
  });
  if (cands.length < 4) throw new Error(`Found ${cands.length} corner markers, need 4. Make sure all four black squares are in the photo.`);
  const maxA = Math.max(...cands.map(c => c.area));
  const big = cands.filter(c => c.area > maxA * 0.3);
  if (big.length < 4) throw new Error('Corner markers are not clearly visible.');
  const pick = (fn) => big.reduce((a, c) => (fn(c) > fn(a) ? c : a));
  const tl = pick(c => -(c.cx + c.cy)), br = pick(c => c.cx + c.cy);
  const tr = pick(c => c.cx - c.cy), bl = pick(c => c.cy - c.cx);
  const set = new Set([tl, tr, br, bl]);
  if (set.size < 4) throw new Error('Could not tell the four corner markers apart.');
  return [tl, tr, br, bl].map(c => ({ x: c.cx + 0.5, y: c.cy + 0.5 }));
}

/** Mean luminance in a square of template units around (x,y). */
function probe(lum, H, x, y, r) {
  let s = 0, n = 0;
  for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
    const p = H(x + (i * r) / 2, y + (j * r) / 2);
    s += sample(lum, p.x, p.y); n++;
  }
  return s / n;
}

/**
 * Read a photographed / scanned sheet.
 * lum: full-resolution luminance field. Returns { page, samples, skipped }.
 */
export function readSheet(lum, { forcePage = null, maxDetect = 1400, pages: extra = [] } = {}) {
  // Standard sheets by index, plus any custom (gap-filler) sheets by their page code.
  const pages = PAGES.slice();
  for (const p of extra) pages[p.index] = p;
  const sc = Math.min(1, maxDetect / Math.max(lum.w, lum.h));
  const small = sc < 1 ? resize(lum, lum.w * sc, lum.h * sc) : lum;
  const fid = findFiducials(small).map(p => ({ x: p.x / sc - 0.5, y: p.y / sc - 0.5 }));
  const H = homography(FIDUCIALS, fid);

  // Page code.
  const fidDark = probe(lum, H, FIDUCIALS[0].x, FIDUCIALS[0].y, FID * 0.5);
  const bits = [], paper = [];
  for (let k = 0; k < BITS; k++) {
    const c = bitCenter(k);
    bits.push(probe(lum, H, c.x, c.y, BIT * 0.5));
    paper.push(probe(lum, H, c.x, c.y + 330, BIT * 0.4));
  }
  const paperL = quantile(paper, 0.5);
  const cut = (paperL + fidDark) / 2;
  const b = bits.map(v => (v < cut ? 1 : 0));
  const parityOk = b.slice(0, 5).reduce((a, c) => a ^ c, 0) === b[5];
  let page = b.slice(0, 5).reduce((a, c, k) => a | (c << k), 0);
  if (forcePage != null) page = forcePage;
  else if (!parityOk || !pages[page]) throw new Error('Could not read the sheet number. Pick the sheet manually.');

  const cells = pages[page].cells;
  const pw = Math.round(CELL.w / UPP), ph = Math.round(CELL.h / UPP);
  const samples = [], skipped = [];
  cells.forEach((ch, i) => {
    const r = cellRect(i);
    // Resample the cell (2x2 supersampling) into normalized space.
    const cellLum = field(pw, ph);
    for (let v = 0; v < ph; v++) for (let u = 0; u < pw; u++) {
      let s = 0;
      for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
        const p = H(r.x + (u + 0.25 + k * 0.5) * UPP, r.y + (v + 0.25 + j * 0.5) * UPP);
        s += sample(lum, p.x, p.y);
      }
      cellLum.data[v * pw + u] = s / 4;
    }
    let ink = inkFromPaper(cellLum, { paper: quantile(cellLum.data, 0.85), lightCut: 0.66 });
    const mg = Math.round(CELL.margin / UPP);
    for (let v = 0; v < ph; v++) for (let u = 0; u < pw; u++) {
      if (u < mg || v < mg || u >= pw - mg || v >= ph - mg) ink.data[v * pw + u] = 0;
    }
    ink = despeckle(ink, 14);
    const bb = bbox(ink, 0.5);
    let total = 0; for (const v of ink.data) total += v;
    if (!bb || total < 40) { skipped.push({ char: ch, index: i }); return; }
    const p = 3;
    const x0 = Math.max(0, bb.x0 - p), y0 = Math.max(0, bb.y0 - p);
    const cw = Math.min(pw, bb.x1 + p + 1) - x0, chh = Math.min(ph, bb.y1 + p + 1) - y0;
    const c = crop(ink, x0, y0, cw, chh);
    samples.push({
      id: `sheet${page}-${i}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      char: ch, w: c.w, h: c.h, ink: c.data, baseline: CELL.baseLine / UPP - y0,
      source: `sheet ${page + 1}`, created: Date.now() + i,
    });
  });
  return { page, samples, skipped, corners: fid };
}
