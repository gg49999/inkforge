// Forced alignment of a known transcription onto segmented handwriting.
//
// Joined-up writing rarely gives one blob per letter, so instead of requiring
// exact counts we solve two dynamic programs:
//   1. page level: physical text lines  <->  detected ink lines (skips allowed)
//   2. line level: characters           <->  ink boxes, where a box may hold
//      several letters (split later at the thinnest joins), two boxes may form
//      one letter (broken strokes), and stray boxes / unwritten chars can be
//      skipped. Costs come from expected letter widths and word-gap agreement.
// Each resulting letter is cut out and tagged with a quality score.

const NARROW = new Set([...'il.,;:!|\'`1j']);
const MID = new Set([...'tfr()[]{}-/\\"']);
const WIDE = new Set([...'mwMW@%']);

/** Rough expected width of a character in x-heights (print handwriting). */
export function charWidth(c) {
  if (NARROW.has(c)) return c === 'j' ? 0.45 : 0.32;
  if (MID.has(c)) return 0.55;
  if (WIDE.has(c)) return 1.25;
  if (c === 'I' || c === 'J') return 0.5;
  if (/[A-Z]/.test(c)) return 0.95;
  if (/[0-9]/.test(c)) return 0.7;
  return 0.8;
}

function spanWidth(chars, a, b) { let s = 0; for (let i = a; i < b; i++) s += chars[i].w; return s; }

/** chars: [{c, w, wordEnd}] from a text line. */
export function lineChars(text) {
  const out = [];
  const t = text.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === ' ') { if (out.length) out[out.length - 1].wordEnd = true; continue; }
    out.push({ c, w: charWidth(c), wordEnd: false });
  }
  if (out.length) out[out.length - 1].wordEnd = true;
  return out;
}

/**
 * Align chars to boxes on one line. boxes: [{x0, x1}] in deslanted x, sorted.
 * Returns { cost, steps: [{type, box:[i..], chars:[a,b)}] }.
 */
export function alignLine(boxes, chars, xh, gapCut) {
  const n = boxes.length, m = chars.length;
  if (!n || !m) return { cost: Infinity, steps: [] };
  const inkW = boxes.reduce((s, b) => s + (b.x1 - b.x0 + 1), 0);
  const scale = inkW / Math.max(1e-6, spanWidth(chars, 0, m)); // px per x-height-width unit
  const gapAfter = boxes.map((b, i) => (i < n - 1 ? boxes[i + 1].x0 - b.x1 : Infinity));
  const INF = 1e18;
  const D = new Float64Array((n + 1) * (m + 1)).fill(INF);
  const back = new Array((n + 1) * (m + 1));
  const idx = (i, j) => i * (m + 1) + j;
  D[0] = 0;
  const fit = (px, a, b) => {
    const e = scale * spanWidth(chars, a, b);
    const r = Math.log(Math.max(1, px) / Math.max(1, e));
    return 4 * r * r;
  };
  const gapCost = (i, j) => {
    // box i ends right before char j (exclusive) — does the gap agree with a word break?
    if (i >= n - 1 || j >= m) return 0;
    const big = gapAfter[i] > gapCut;
    const wordEnd = chars[j - 1].wordEnd;
    if (big && !wordEnd) return 1.2;
    if (!big && wordEnd) return 0.5;
    return 0;
  };
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const here = D[idx(i, j)];
    if (here >= INF) continue;
    const relax = (ni, nj, c, step) => {
      const k = idx(ni, nj);
      if (here + c < D[k]) { D[k] = here + c; back[k] = { pi: i, pj: j, ...step }; }
    };
    if (i < n) {
      const bw = boxes[i].x1 - boxes[i].x0 + 1;
      // One box holds k letters.
      for (let k = 1; k <= 6 && j + k <= m; k++) {
        let cross = 0;
        for (let q = j; q < j + k - 1; q++) if (chars[q].wordEnd) cross += 1.6;
        const c = fit(bw, j, j + k) + 0.25 * (k - 1) + cross + gapCost(i, j + k);
        relax(i + 1, j + k, c, { type: k === 1 ? 'single' : 'split', boxes: [i], a: j, b: j + k });
      }
      // Two boxes make one letter (broken stroke).
      if (i + 1 < n && j < m && gapAfter[i] < gapCut * 0.6) {
        const w2 = boxes[i + 1].x1 - boxes[i].x0 + 1;
        relax(i + 2, j + 1, fit(w2, j, j + 1) + 0.9 + gapCost(i + 1, j + 1), { type: 'merged', boxes: [i, i + 1], a: j, b: j + 1 });
      }
      // Stray mark.
      relax(i + 1, j, 1.6, { type: 'skipbox', boxes: [i], a: j, b: j });
    }
    // Letter not found in ink.
    if (j < m) relax(i, j + 1, 1.6, { type: 'skipchar', boxes: [], a: j, b: j + 1 });
  }
  const steps = [];
  let i = n, j = m;
  while (i || j) {
    const b = back[idx(i, j)];
    if (!b) break;
    steps.push(b);
    i = b.pi; j = b.pj;
  }
  steps.reverse();
  return { cost: D[idx(n, m)], steps, scale };
}

/** Match text lines to detected lines. Returns array: textLine index -> detected line index | -1. */
export function alignLines(lineInfos, textLines) {
  const p = lineInfos.length, q = textLines.length;
  const totalInk = lineInfos.reduce((s, l) => s + l.inkW, 0);
  const totalExp = textLines.reduce((s, t) => s + t.expW, 0);
  const scale = totalInk / Math.max(1e-6, totalExp);
  const INF = 1e18;
  const D = new Float64Array((p + 1) * (q + 1)).fill(INF);
  const back = new Array((p + 1) * (q + 1));
  const id = (a, b) => a * (q + 1) + b;
  D[0] = 0;
  for (let a = 0; a <= p; a++) for (let b = 0; b <= q; b++) {
    const here = D[id(a, b)];
    if (here >= INF) continue;
    const relax = (na, nb, c, mv) => { const k = id(na, nb); if (here + c < D[k]) { D[k] = here + c; back[k] = { a, b, mv }; } };
    if (a < p && b < q) {
      const r = Math.log(Math.max(1, lineInfos[a].inkW) / Math.max(1, scale * textLines[b].expW));
      relax(a + 1, b + 1, r * r, 'match');
    }
    if (a < p) relax(a + 1, b, 0.9, 'skipline');   // header / stray marks
    if (b < q) relax(a, b + 1, 1.2, 'skiptext');   // text whose ink line was not found
  }
  const map = new Array(q).fill(-1);
  let a = p, b = q;
  while (a || b) {
    const s = back[id(a, b)];
    if (!s) break;
    if (s.mv === 'match') map[s.b] = s.a;
    a = s.a; b = s.b;
  }
  return map;
}

/**
 * Cut letter crops for an aligned line.
 * ctx: { f (ink field), labels, tanS, line (lineReport) }
 */
export function cutLetters(ctx, boxes, chars, alignment) {
  const { f, labels, tanS, line } = ctx;
  const baseAt = x => line.icpt + line.slope * x;
  const out = [];
  for (const st of alignment.steps) {
    if (st.type === 'skipbox' || st.type === 'skipchar') continue;
    const bx = st.boxes.map(i => boxes[i]);
    const ids = new Set(bx.flatMap(b => b.comps.map(c => c.id)));
    const y0 = Math.min(...bx.map(b => b.y0)), y1 = Math.max(...bx.map(b => b.y1));
    const rx0 = Math.min(...bx.map(b => b.rx0)), rx1 = Math.max(...bx.map(b => b.rx1));
    const base = baseAt((rx0 + rx1) / 2);
    const dx = (y) => (y - base) * tanS; // deslant offset
    // Column profile in deslanted space.
    const X0 = Math.floor(Math.min(...bx.map(b => b.x0))) - 1, X1 = Math.ceil(Math.max(...bx.map(b => b.x1))) + 1;
    const prof = new Float64Array(X1 - X0 + 1);
    for (let y = y0; y <= y1; y++) for (let x = rx0; x <= rx1; x++) {
      if (!ids.has(labels[y * f.w + x])) continue;
      const c = Math.round(x + dx(y)) - X0;
      if (c >= 0 && c < prof.length) prof[c]++;
    }
    // Ink extent in deslanted space.
    let e0 = 0, e1 = prof.length - 1;
    while (e0 < e1 && !prof[e0]) e0++;
    while (e1 > e0 && !prof[e1]) e1--;
    const k = st.b - st.a;
    const cuts = [e0];
    if (k > 1) {
      const tot = spanWidth(chars, st.a, st.b);
      let acc = 0;
      for (let q = st.a; q < st.b - 1; q++) {
        acc += chars[q].w;
        const exp = e0 + ((e1 - e0) * acc) / tot;
        const win = Math.max(2, ((e1 - e0) * chars[q].w) / tot * 0.4);
        let best = Math.round(exp), bv = Infinity;
        for (let c = Math.max(cuts[cuts.length - 1] + 2, Math.round(exp - win)); c <= Math.min(e1 - 2, Math.round(exp + win)); c++) {
          // Prefer thin joins, mildly prefer the expected spot.
          const v = prof[c] + Math.abs(c - exp) * 0.15;
          if (v < bv) { bv = v; best = c; }
        }
        cuts.push(best);
      }
    }
    cuts.push(e1 + 1);
    for (let q = 0; q < k; q++) {
      const c0 = cuts[q] + X0, c1 = cuts[q + 1] + X0; // deslanted column range [c0, c1)
      // Pixel bounds of this piece.
      let px0 = Infinity, px1 = -Infinity, py0 = Infinity, py1 = -Infinity;
      for (let y = y0; y <= y1; y++) for (let x = rx0; x <= rx1; x++) {
        if (!ids.has(labels[y * f.w + x])) continue;
        const xs = x + dx(y);
        if (xs < c0 - 0.5 || xs >= c1 - 0.5) continue;
        if (x < px0) px0 = x; if (x > px1) px1 = x; if (y < py0) py0 = y; if (y > py1) py1 = y;
      }
      if (!isFinite(px0)) continue;
      const pad = 3;
      const cx0 = Math.max(0, px0 - pad), cx1 = Math.min(f.w - 1, px1 + pad);
      const cy0 = Math.max(0, py0 - pad), cy1 = Math.min(f.h - 1, py1 + pad);
      const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
      const crop = new Float32Array(cw * ch);
      for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
        const xs = x + dx(y);
        if (xs < c0 - 1.5 || xs >= c1 + 0.5) continue;
        const i = y * f.w + x;
        let mine = ids.has(labels[i]);
        if (!mine && !labels[i]) {
          for (let yy = y - 1; yy <= y + 1 && !mine; yy++) for (let xx = x - 1; xx <= x + 1; xx++) {
            if (xx >= 0 && yy >= 0 && xx < f.w && yy < f.h && ids.has(labels[yy * f.w + xx])) { mine = true; break; }
          }
        }
        if (mine) crop[(y - cy0) * cw + (x - cx0)] = f.data[i];
      }
      const ch0 = chars[st.a + q];
      const pieceW = c1 - c0;
      const expW = alignment.scale * ch0.w;
      const r = Math.log(Math.max(1, pieceW) / Math.max(1, expW));
      out.push({
        label: ch0.c, kind: st.type, fitError: r * r,
        quality: st.type === 'single' ? 1 / (1 + 4 * r * r) : st.type === 'merged' ? 0.6 / (1 + 4 * r * r) : 0.75 / (1 + 4 * r * r + 0.1 * k),
        box: { x0: cx0, y0: cy0, x1: cx1, y1: cy1 }, crop: { w: cw, h: ch, data: crop },
        baselineInCrop: baseAt((cx0 + cx1) / 2) - cy0, xHeight: line.xHeight,
      });
    }
  }
  return out;
}
