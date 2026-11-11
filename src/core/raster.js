// Raster primitives. Pure JS, no DOM, so everything here runs in Node and the browser.
//
// Conventions:
//   Field  = { w, h, data: Float32Array }   (row-major, values usually 0..1)
//   Mask   = { w, h, data: Uint8Array }     (0 / 1)
// "Ink" fields store coverage: 1 = full ink, 0 = paper.

export function field(w, h, data) {
  return { w, h, data: data || new Float32Array(w * h) };
}

export function mask(w, h, data) {
  return { w, h, data: data || new Uint8Array(w * h) };
}

/** RGBA bytes (canvas ImageData layout) -> luminance field 0..1 (1 = white). */
export function luminance(rgba, w, h) {
  const out = new Float32Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (0.2126 * rgba[j] + 0.7152 * rgba[j + 1] + 0.0722 * rgba[j + 2]) / 255;
  }
  return field(w, h, out);
}

/** Bilinear sample with edge clamping. */
export function sample(f, x, y) {
  const { w, h, data } = f;
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const x0 = x | 0, y0 = y | 0;
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const fx = x - x0, fy = y - y0;
  const a = data[y0 * w + x0], b = data[y0 * w + x1];
  const c = data[y1 * w + x0], d = data[y1 * w + x1];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Area-averaging downscale (or bilinear upscale) to a new size. */
export function resize(f, nw, nh) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  const out = new Float32Array(nw * nh);
  const sx = f.w / nw, sy = f.h / nh;
  if (sx <= 1 && sy <= 1) {
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      out[y * nw + x] = sample(f, (x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5);
    }
    return field(nw, nh, out);
  }
  // Box filter: supersample each destination pixel.
  const ssx = Math.max(1, Math.ceil(sx)), ssy = Math.max(1, Math.ceil(sy));
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    let acc = 0;
    for (let j = 0; j < ssy; j++) for (let i = 0; i < ssx; i++) {
      acc += sample(f, x * sx + (i + 0.5) * sx / ssx - 0.5, y * sy + (j + 0.5) * sy / ssy - 0.5);
    }
    out[y * nw + x] = acc / (ssx * ssy);
  }
  return field(nw, nh, out);
}

/** Separable gaussian blur. */
export function blur(f, sigma) {
  if (sigma <= 0.05) return field(f.w, f.h, f.data.slice());
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const { w, h } = f;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        let xx = x + i; if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
        acc += f.data[row + xx] * k[i + r];
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) {
      let yy = y + i; if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
      acc += tmp[yy * w + x] * k[i + r];
    }
    out[y * w + x] = acc;
  }
  return field(w, h, out);
}

/** Pad a field with a constant border. */
export function pad(f, p, value = 0) {
  const w = f.w + 2 * p, h = f.h + 2 * p;
  const out = new Float32Array(w * h).fill(value);
  for (let y = 0; y < f.h; y++) out.set(f.data.subarray(y * f.w, (y + 1) * f.w), (y + p) * w + p);
  return field(w, h, out);
}

export function crop(f, x0, y0, cw, ch) {
  const out = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = x + x0, sy = y + y0;
    out[y * cw + x] = sx >= 0 && sy >= 0 && sx < f.w && sy < f.h ? f.data[sy * f.w + sx] : 0;
  }
  return field(cw, ch, out);
}

/** Otsu threshold over values in 0..1. Returns the threshold. */
export function otsu(values, bins = 256) {
  const hist = new Float64Array(bins);
  let n = 0;
  for (const v of values) { hist[Math.min(bins - 1, Math.max(0, (v * (bins - 1)) | 0))]++; n++; }
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = i; }
  }
  return (thr + 0.5) / (bins - 1);
}

/**
 * Adaptive ink extraction for photographed paper (Sauvola-style).
 * Takes a luminance field, returns an ink-coverage field 0..1 with soft edges,
 * which keeps sub-pixel detail for the tracer.
 */
export function inkFromLuminance(lum, { window = 0, k = 0.25, softness = 0.08 } = {}) {
  const { w, h, data } = lum;
  const win = window || Math.max(15, Math.round(Math.min(w, h) / 12)) | 1;
  const r = win >> 1;
  // Integral images of value and value^2.
  const W = w + 1;
  const I = new Float64Array(W * (h + 1)), I2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      rs += v; rs2 += v * v;
      I[(y + 1) * W + x + 1] = I[y * W + x + 1] + rs;
      I2[(y + 1) * W + x + 1] = I2[y * W + x + 1] + rs2;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const s = I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
      const s2 = I2[y1 * W + x1] - I2[y0 * W + x1] - I2[y1 * W + x0] + I2[y0 * W + x0];
      const mean = s / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      // Sauvola: T = m * (1 + k (sd/R - 1)), R = 0.5 for 0..1 data.
      const T = mean * (1 + k * (sd / 0.5 - 1));
      // Also refuse to call anything "ink" that is nearly as bright as the paper.
      const v = data[y * w + x];
      const c = (T - v) / softness + 0.5;
      out[y * w + x] = c <= 0 ? 0 : c >= 1 ? 1 : c;
    }
  }
  return field(w, h, out);
}

/** Sliding-window max over rows then columns (radius r), O(n) per pass. */
function maxFilter(f, r) {
  const { w, h } = f;
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const dq = new Int32Array(Math.max(w, h));
  const pass = (src, dst, n, stride, count, step) => {
    for (let line = 0; line < count; line++) {
      const base = line * step;
      let head = 0, tail = 0;
      for (let i = 0; i < n + r; i++) {
        if (i < n) {
          const v = src[base + i * stride];
          while (tail > head && src[base + dq[tail - 1] * stride] <= v) tail--;
          dq[tail++] = i;
        }
        const c = i - r;
        if (c >= 0) {
          while (dq[head] < c - r) head++;
          dst[base + c * stride] = src[base + dq[head] * stride];
        }
      }
    }
  };
  pass(f.data, tmp, w, 1, h, w);
  pass(tmp, out, h, w, w, 1);
  return field(w, h, out);
}

/**
 * Flat-field ink extraction for casual photos: estimate the local paper
 * brightness (max filter wide enough to jump over strokes, then smoothed), divide
 * it out, and threshold the ratio. Shadows, vignetting and warm/cool light
 * gradients all cancel; only marks clearly darker than nearby paper remain.
 */
export function inkFlatField(lum, { radius = 0, cut = 0.8, softness = 0.12 } = {}) {
  const r = radius || Math.max(6, Math.round(Math.min(lum.w, lum.h) / 90));
  const bg = blur(maxFilter(lum, r), r * 0.8);
  const out = new Float32Array(lum.data.length);
  for (let i = 0; i < out.length; i++) {
    const n = lum.data[i] / Math.max(0.04, bg.data[i]);
    const c = (cut - n) / softness + 0.5;
    out[i] = c <= 0 ? 0 : c >= 1 ? 1 : c;
  }
  return field(lum.w, lum.h, out);
}

/**
 * Ink extraction against a known clean paper level (template cells, scans).
 * Anything lighter than `paper * lightCut` is paper (kills pale printed guides).
 */
export function inkFromPaper(lum, { paper, dark, lightCut = 0.72 } = {}) {
  const vals = Array.from(lum.data);
  if (paper == null) { const s = vals.slice().sort((a, b) => a - b); paper = s[Math.floor(s.length * 0.9)]; }
  if (dark == null) dark = Math.min(paper * 0.35, 0.3);
  const hi = paper * lightCut, lo = Math.max(dark, hi - 0.25);
  const out = new Float32Array(lum.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = lum.data[i];
    const c = (hi - v) / (hi - lo);
    out[i] = c <= 0 ? 0 : c >= 1 ? 1 : c;
  }
  return field(lum.w, lum.h, out);
}

export function threshold(f, t = 0.5) {
  const m = new Uint8Array(f.w * f.h);
  for (let i = 0; i < m.length; i++) m[i] = f.data[i] > t ? 1 : 0;
  return mask(f.w, f.h, m);
}

/**
 * 8-connected component labeling. Returns { labels: Int32Array, comps: [...] }
 * where each comp has { id, area, x0, y0, x1, y1, cx, cy } (x1/y1 inclusive).
 */
export function components(m, { minArea = 1 } = {}) {
  const { w, h, data } = m;
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = new Int32Array(w * h);
  let next = 1;
  for (let start = 0; start < data.length; start++) {
    if (!data[start] || labels[start]) continue;
    const id = next++;
    let sp = 0; stack[sp++] = start; labels[start] = id;
    let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0, sx = 0, sy = 0;
    while (sp) {
      const p = stack[--sp];
      const x = p % w, y = (p / w) | 0;
      area++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (data[q] && !labels[q]) { labels[q] = id; stack[sp++] = q; }
        }
      }
    }
    comps.push({ id, area, x0, y0, x1, y1, cx: sx / area, cy: sy / area });
  }
  const kept = comps.filter(c => c.area >= minArea);
  return { labels, comps: kept, all: comps };
}

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    while (true) {
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      if (s <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/**
 * Euclidean distance transform: for every pixel, distance to the nearest pixel
 * where `m.data` is 0 (i.e. distance from inside a shape to its edge).
 */
export function edt(m) {
  const { w, h, data } = m;
  const INF = 1e20;
  const g = new Float64Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = data[i] ? INF : 0;
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return field(w, h, Float32Array.from(g));
}

/** Signed distance (px): positive inside ink, negative outside. */
export function signedDistance(m) {
  const inside = edt(m);
  const inv = mask(m.w, m.h, m.data.map(v => (v ? 0 : 1)));
  const outside = edt(inv);
  const out = new Float32Array(m.w * m.h);
  for (let i = 0; i < out.length; i++) out[i] = m.data[i] ? inside.data[i] - 0.5 : -(outside.data[i] - 0.5);
  return field(m.w, m.h, out);
}

/**
 * Change stroke weight of an ink field by `delta` pixels (positive = bolder),
 * keeping soft edges for the tracer.
 */
export function embolden(ink, delta) {
  // Caller must leave at least ceil(delta)+2 px of empty margin around the ink.
  if (Math.abs(delta) < 0.05) return ink;
  const sd = signedDistance(threshold(ink, 0.5));
  const out = new Float32Array(sd.data.length);
  for (let i = 0; i < out.length; i++) {
    const v = 0.5 + sd.data[i] + delta;
    out[i] = v <= 0 ? 0 : v >= 1 ? 1 : v;
  }
  return blur(field(ink.w, ink.h, out), 0.6);
}

/** Remove connected specks smaller than minArea pixels (in-place on a copy). */
export function despeckle(ink, minArea, t = 0.5) {
  const m = threshold(ink, t);
  const { labels, all } = components(m);
  const small = new Set(all.filter(c => c.area < minArea).map(c => c.id));
  const out = ink.data.slice();
  if (small.size) {
    // Pixels belonging to tiny components, plus their faint halo, are cleared.
    for (let i = 0; i < out.length; i++) if (small.has(labels[i])) out[i] = 0;
  }
  return field(ink.w, ink.h, out);
}

/** Tight bounding box of values above t, or null. */
export function bbox(f, t = 0.5) {
  let x0 = f.w, y0 = f.h, x1 = -1, y1 = -1;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
    if (f.data[y * f.w + x] > t) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(arr, q) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}

export function mean(arr) { let s = 0; for (const v of arr) s += v; return arr.length ? s / arr.length : 0; }
export function std(arr) { const m = mean(arr); let s = 0; for (const v of arr) s += (v - m) ** 2; return arr.length ? Math.sqrt(s / arr.length) : 0; }
