// Small DOM + canvas helpers shared by the views.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const thumbCache = new Map();
/** Ink sample -> data URL thumbnail (ink coloured, transparent paper). */
export function sampleThumb(s, color) {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) color = cssVar('--ink');
  if (!/^#[0-9a-f]{6}$/i.test(color)) color = '#1d2433';
  const key = s.id + color;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = document.createElement('canvas');
  c.width = s.w; c.height = s.h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(s.w, s.h);
  const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
  for (let i = 0; i < s.ink.length; i++) {
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = Math.round(Math.min(1, s.ink[i]) * 255);
  }
  ctx.putImageData(img, 0, 0);
  const url = c.toDataURL();
  thumbCache.set(key, url);
  return url;
}

export function forgetThumb(id) {
  for (const k of [...thumbCache.keys()]) if (k.startsWith(id)) thumbCache.delete(k);
}

/** Append a TrueType contour ({x,y,on}[]) to a Path2D via transform fn. */
export function addContour(path, pts, T) {
  const n = pts.length;
  if (n < 2) return;
  let start = pts.findIndex(p => p.on);
  let first;
  if (start < 0) { first = { x: (pts[0].x + pts[n - 1].x) / 2, y: (pts[0].y + pts[n - 1].y) / 2, on: true }; start = 0; }
  else { first = pts[start]; start = start + 1; }
  const P = T(first.x, first.y);
  path.moveTo(P[0], P[1]);
  let ctrl = null;
  for (let k = 0; k < n; k++) {
    const p = pts[(start + k) % n];
    if (p === first) continue;
    if (p.on) {
      const Q = T(p.x, p.y);
      if (ctrl) { const C = T(ctrl.x, ctrl.y); path.quadraticCurveTo(C[0], C[1], Q[0], Q[1]); ctrl = null; }
      else path.lineTo(Q[0], Q[1]);
    } else {
      if (ctrl) {
        const mid = { x: (ctrl.x + p.x) / 2, y: (ctrl.y + p.y) / 2 };
        const C = T(ctrl.x, ctrl.y), M = T(mid.x, mid.y);
        path.quadraticCurveTo(C[0], C[1], M[0], M[1]);
      }
      ctrl = p;
    }
  }
  if (ctrl) { const C = T(ctrl.x, ctrl.y); path.quadraticCurveTo(C[0], C[1], P[0], P[1]); }
  path.closePath();
}

/** Draw a glyph outline into a canvas, fitted to a shared em box. */
export function drawGlyph(canvas, glyph, { color = '#1d2433', guides = true, points = false, em = { top: 950, bottom: -350 } } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 90, H = canvas.clientHeight || 110;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const s = H / (em.top - em.bottom);
  const ox = (W - glyph.advance * s) / 2;
  const T = (x, y) => [ox + x * s, (em.top - y) * s];
  if (guides) {
    ctx.strokeStyle = cssVar('--guide') || '#c9d6ea';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const yb = em.top * s, yx = (em.top - 500) * s;
    ctx.moveTo(0, yb); ctx.lineTo(W, yb);
    ctx.setLineDash([3, 3]); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, yx); ctx.lineTo(W, yx); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = cssVar('--advance') || 'rgba(120,140,200,.08)';
    ctx.fillRect(ox, 0, glyph.advance * s, H);
  }
  const path = new Path2D();
  for (const c of glyph.contours) addContour(path, c, T);
  ctx.fillStyle = color;
  ctx.fill(path, 'nonzero');
  if (points) {
    for (const c of glyph.contours) for (const p of c) {
      const [x, y] = T(p.x, p.y);
      ctx.fillStyle = p.on ? '#e0624a' : '#4a7be0';
      ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
    }
  }
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** File -> {canvas, rgba, w, h} downscaled so the long side <= maxSide. */
export async function loadImage(file, maxSide = 4000) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  return { canvas: c, rgba, w, h };
}

export function toast(msg, kind = 'info') {
  let host = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  setTimeout(() => t.classList.add('out'), 3600);
  setTimeout(() => t.remove(), 4200);
}
