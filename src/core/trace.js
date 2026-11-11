// Ink field -> vector outlines.
//
// 1. Marching squares on the soft ink field at iso 0.5 gives sub-pixel, smooth,
//    closed contours. The segment direction rule keeps ink on the same side of
//    every contour, so outer shapes and holes come out with opposite winding and
//    no nesting analysis is needed.
// 2. Ramer–Douglas–Peucker thins the dense polyline.
// 3. Vertices become TrueType quadratic control points: smooth vertices are
//    off-curve (TrueType implies on-curve midpoints between them, i.e. a
//    quadratic B-spline), sharp corners stay on-curve.

import { pad } from './raster.js';

/**
 * Iso-contours of field f at level iso. Returns arrays of {x,y} in pixel
 * coordinates of f (pixel centers at integer coordinates).
 * Contours wind with ink on the left in y-down screen space.
 */
export function isoContours(f0, iso = 0.5) {
  const P = 1;
  const f = pad(f0, P, 0);
  const { w, h, data } = f;
  const inside = (x, y) => data[y * w + x] > iso;
  const val = (x, y) => data[y * w + x];
  // Edge ids: horizontal edge from (x,y) to (x+1,y): 2*(y*w+x); vertical (x,y)-(x,y+1): 2*(y*w+x)+1.
  const pts = new Map();
  const point = (id) => {
    let p = pts.get(id);
    if (p) return p;
    const base = id >> 1, x = base % w, y = (base / w) | 0;
    let x2 = x, y2 = y;
    if (id & 1) y2++; else x2++;
    const a = val(x, y), b = val(x2, y2);
    const t = Math.abs(b - a) < 1e-9 ? 0.5 : (iso - a) / (b - a);
    p = { x: x + (x2 - x) * t - P, y: y + (y2 - y) * t - P };
    pts.set(id, p);
    return p;
  };
  const next = new Map(); // startEdge -> endEdge
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const c = [inside(x, y), inside(x + 1, y), inside(x + 1, y + 1), inside(x, y + 1)];
      const n = c[0] + c[1] + c[2] + c[3];
      if (n === 0 || n === 4) continue;
      // Edges in clockwise order (screen): top, right, bottom, left.
      // Edge k goes from corner k to corner k+1.
      const edges = [2 * (y * w + x), 2 * (y * w + x + 1) + 1, 2 * ((y + 1) * w + x), 2 * (y * w + x) + 1];
      const cross = []; // {k, entry}
      for (let k = 0; k < 4; k++) {
        const a = c[k], b = c[(k + 1) & 3];
        if (a !== b) cross.push({ k, entry: !a && b });
      }
      const saddle = cross.length === 4;
      const connected = saddle && (val(x, y) + val(x + 1, y) + val(x + 1, y + 1) + val(x, y + 1)) / 4 > iso;
      for (let i = 0; i < cross.length; i++) {
        if (!cross[i].entry) continue;
        let j;
        if (connected) j = (i - 1 + cross.length) % cross.length; // previous exit
        else j = (i + 1) % cross.length; // next exit
        next.set(edges[cross[i].k], edges[cross[j].k]);
      }
    }
  }
  const contours = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let e = start, guard = 0;
    while (!seen.has(e) && guard++ < 1e7) {
      seen.add(e);
      loop.push(point(e));
      e = next.get(e);
      if (e === undefined) break;
    }
    if (loop.length >= 3) contours.push(loop);
  }
  return contours;
}

/** Signed area (shoelace). Positive = clockwise in y-down space. */
export function signedArea(poly) {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function perpDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  if (L < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / Math.sqrt(L);
}

function rdpOpen(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let best = -1, bi = -1;
    for (let i = s + 1; i < e; i++) {
      const d = perpDist(pts[i], pts[s], pts[e]);
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([s, bi], [bi, e]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** RDP for closed polygons: split at the two mutually farthest-ish points. */
export function simplifyClosed(poly, eps) {
  const n = poly.length;
  if (n < 8) return poly.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (poly[i].x - poly[0].x) ** 2 + (poly[i].y - poly[0].y) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const a = rdpOpen(poly.slice(0, far + 1), eps);
  const b = rdpOpen(poly.slice(far).concat([poly[0]]), eps);
  const out = a.concat(b.slice(1, -1));
  return out.length >= 3 ? out : poly.slice(0, 3);
}

/** Light Laplacian smoothing that preserves strong corners. */
export function smoothClosed(poly, passes = 1, cornerDeg = 60) {
  let p = poly;
  const cosLimit = Math.cos((cornerDeg * Math.PI) / 180);
  for (let k = 0; k < passes; k++) {
    const n = p.length;
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n];
      if (turnCos(a, b, c) < cosLimit) { out[i] = b; continue; }
      out[i] = { x: b.x * 0.5 + (a.x + c.x) * 0.25, y: b.y * 0.5 + (a.y + c.y) * 0.25 };
    }
    p = out;
  }
  return p;
}

/** Cosine of the turn angle at b (1 = straight, -1 = full reversal). */
function turnCos(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return 1;
  return (ux * vx + uy * vy) / (lu * lv);
}

/**
 * Convert a simplified polygon into TrueType points [{x,y,on}].
 * Vertices whose turn exceeds cornerDeg are on-curve; others are off-curve.
 * Long straight edges get their endpoints pinned on-curve so they stay straight.
 */
export function toQuadPoints(poly, { cornerDeg = 55, straightLen = Infinity } = {}) {
  const n = poly.length;
  const cosLimit = Math.cos((cornerDeg * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = poly[(i - 1 + n) % n], b = poly[i], c = poly[(i + 1) % n];
    const corner = turnCos(a, b, c) < cosLimit;
    const longIn = Math.hypot(b.x - a.x, b.y - a.y) > straightLen;
    const longOut = Math.hypot(c.x - b.x, c.y - b.y) > straightLen;
    pts.push({ x: b.x, y: b.y, on: corner || longIn || longOut });
  }
  if (!pts.some(p => p.on)) {
    // Pure B-spline loop is legal TrueType, but give it one explicit start point
    // (the implied midpoint between the first two off-curve points).
    const a = pts[n - 1], b = pts[0];
    pts.unshift({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  }
  return pts;
}

/**
 * Full pipeline: ink field -> list of polygons (pixel space, y-down).
 * Small contours (specks / pinholes) are dropped.
 */
export function traceField(f, { minArea = 6, eps = 0.35, smooth = 1 } = {}) {
  const raw = isoContours(f, 0.5);
  const out = [];
  for (const c of raw) {
    if (Math.abs(signedArea(c)) < minArea) continue;
    let p = smoothClosed(c, smooth);
    p = simplifyClosed(p, eps);
    if (p.length >= 3 && Math.abs(signedArea(p)) >= minArea * 0.5) out.push(p);
  }
  return out;
}
