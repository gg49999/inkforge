// Find the sheet of paper in a casual photo (desk, wood table, other papers)
// so only writing on the page is analyzed.

import { field, mask, components } from './raster.js';

/**
 * rgba: canvas bytes, w/h: size. Returns a Field (1 = on the page) at full size,
 * plus the page bounding box. Paper = bright, low-saturation pixels; the largest
 * such region wins, then holes (the writing itself) are filled and the edge is
 * pulled in slightly so the paper border never reads as ink.
 */
export function findPaper(rgba, w, h, { maxSide = 480 } = {}) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * s)), sh = Math.max(1, Math.round(h * s));
  const lum = new Float32Array(sw * sh), sat = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    // Box-average the source block.
    const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.floor((x + 1) / s));
    const y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.floor((y + 1) / s));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1 && yy < h; yy += 2) for (let xx = x0; xx < x1 && xx < w; xx += 2) {
      const i = (yy * w + xx) * 4; r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
    }
    r /= n * 255; g /= n * 255; b /= n * 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    lum[y * sw + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sat[y * sw + x] = mx > 0 ? (mx - mn) / mx : 0;
  }
  // Adaptive brightness cut: paper is the bright mode of the image.
  const sorted = Float32Array.from(lum).sort();
  const bright = sorted[Math.floor(sorted.length * 0.9)];
  const m = mask(sw, sh);
  for (let i = 0; i < m.data.length; i++) m.data[i] = lum[i] > bright * 0.55 && sat[i] < 0.28 ? 1 : 0;
  const { labels, comps } = components(m);
  if (!comps.length) return { field: field(w, h, new Float32Array(w * h).fill(1)), box: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, found: false };
  const best = comps.reduce((a, c) => (c.area > a.area ? c : a));
  if (best.area < sw * sh * 0.08) return { field: field(w, h, new Float32Array(w * h).fill(1)), box: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 }, found: false };
  // Outside = non-page pixels reachable from the image border.
  const page = new Uint8Array(sw * sh);
  for (let i = 0; i < page.length; i++) page[i] = labels[i] === best.id ? 1 : 0;
  const outside = new Uint8Array(sw * sh);
  const stack = [];
  const push = (x, y) => { const i = y * sw + x; if (!page[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < sw; x++) { push(x, 0); push(x, sh - 1); }
  for (let y = 0; y < sh; y++) { push(0, y); push(sw - 1, y); }
  while (stack.length) {
    const i = stack.pop(), x = i % sw, y = (i / sw) | 0;
    if (x > 0) push(x - 1, y); if (x < sw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < sh - 1) push(x, y + 1);
  }
  // Erode the page by a few small-scale pixels.
  const er = 3;
  const inside = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    let ok = !outside[y * sw + x];
    for (let d = -er; d <= er && ok; d++) {
      const xx = x + d, yy = y + d;
      if (xx < 0 || xx >= sw || outside[y * sw + xx]) ok = false;
      else if (yy < 0 || yy >= sh || outside[yy * sw + x]) ok = false;
    }
    inside[y * sw + x] = ok ? 1 : 0;
  }
  const out = new Float32Array(w * h);
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.floor(y * s));
    for (let x = 0; x < w; x++) {
      const v = inside[sy * sw + Math.min(sw - 1, Math.floor(x * s))];
      out[y * w + x] = v;
      if (v) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    }
  }
  return { field: field(w, h, out), box: { x0: bx0, y0: by0, x1: bx1, y1: by1 }, found: true };
}
