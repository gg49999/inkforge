// Pen/touch/mouse writing pad. Strokes are captured in font units against the
// same cell geometry as the printed sheets, with pressure (or speed for mice)
// driving pen width, then rendered into a normalized ink sample.

import { CELL } from '../core/constants.js';
import { strokesToSample } from '../core/synth.js';
import { cssVar } from './render.js';

export class DrawPad {
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.strokes = [];
    this.current = null;
    this.penWidth = 60;
    this.char = 'a';
    this.ghost = null; // optional sample to show faintly behind
    this.onChange = onChange || (() => {});
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, e => this.up(e));
    new ResizeObserver(() => this.redraw()).observe(canvas);
  }

  get scale() { return this.canvas.clientWidth / CELL.w; }

  toUnits(e) {
    const r = this.canvas.getBoundingClientRect();
    const s = this.scale;
    return { x: (e.clientX - r.left) / s, y: CELL.baseLine - (e.clientY - r.top) / s, t: e.timeStamp };
  }

  widthFor(e, p, prev) {
    if (e.pointerType === 'pen' && e.pressure > 0) return this.penWidth * (0.45 + 1.0 * e.pressure);
    if (!prev) return this.penWidth;
    const dt = Math.max(1, p.t - prev.t);
    const v = Math.hypot(p.x - prev.x, p.y - prev.y) / dt; // units per ms
    const target = this.penWidth * Math.max(0.65, Math.min(1.15, 1.2 - v * 0.12));
    return prev.w * 0.7 + target * 0.3;
  }

  down(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toUnits(e);
    p.w = this.widthFor(e, p, null);
    this.current = [p];
    this.redraw();
  }

  move(e) {
    if (!this.current) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs.length ? evs : [e]) {
      const p = this.toUnits(ce);
      const prev = this.current[this.current.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) < 6) continue;
      p.w = this.widthFor(ce, p, prev);
      this.current.push(p);
    }
    this.redraw();
  }

  up() {
    if (!this.current) return;
    this.strokes.push(smoothStroke(this.current));
    this.current = null;
    this.redraw();
    this.onChange();
  }

  undo() { this.strokes.pop(); this.redraw(); this.onChange(); }
  clear() { this.strokes = []; this.current = null; this.redraw(); this.onChange(); }
  get empty() { return !this.strokes.length; }

  toSample() {
    if (this.empty) return null;
    const s = strokesToSample(this.char, this.strokes.map(st => st.map(p => ({ x: p.x, y: p.y, w: p.w }))), { penWidth: this.penWidth, source: 'pad' });
    s.id = `pad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return s;
  }

  redraw() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const s = this.scale;
    const Y = y => (CELL.baseLine - y) * s;
    const line = (yCell, color, dash, lw = 1) => {
      ctx.beginPath(); ctx.setLineDash(dash || []); ctx.strokeStyle = color; ctx.lineWidth = lw;
      ctx.moveTo(10, yCell * s); ctx.lineTo(W - 10, yCell * s); ctx.stroke(); ctx.setLineDash([]);
    };
    const g = cssVar('--guide') || '#c9d6ea', gb = cssVar('--guide-strong') || '#8fb0e6';
    line(CELL.ascLine, g, [6, 6]);
    line(CELL.xLine, g, [10, 5]);
    line(CELL.baseLine, gb, null, 2);
    line(CELL.descLine, g, [6, 6]);
    ctx.font = `${Math.round(13)}px system-ui, sans-serif`;
    ctx.fillStyle = cssVar('--muted') || '#888';
    ctx.fillText('ascender', 14, CELL.ascLine * s - 5);
    ctx.fillText('x-height', 14, CELL.xLine * s - 5);
    ctx.fillText('baseline', 14, CELL.baseLine * s - 5);
    // Target character label in the corner (not a tracing guide: we want *your* shapes).
    ctx.save();
    ctx.fillStyle = cssVar('--muted') || '#888';
    ctx.font = `600 ${Math.round(Math.max(18, 160 * s))}px system-ui, sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(this.char, W - 14, Math.max(26, 170 * s));
    ctx.restore();
    const ink = cssVar('--ink') || '#1d2433';
    const all = this.current ? [...this.strokes, this.current] : this.strokes;
    for (const st of all) drawStroke(ctx, st, p => [p.x * s, Y(p.y)], s, ink);
  }
}

function smoothStroke(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    out.push({ x: (a.x + 2 * b.x + c.x) / 4, y: (a.y + 2 * b.y + c.y) / 4, w: (a.w + 2 * b.w + c.w) / 4, t: b.t });
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function drawStroke(ctx, st, T, s, color) {
  ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (st.length === 1) {
    const [x, y] = T(st[0]);
    ctx.beginPath(); ctx.arc(x, y, (st[0].w * s) / 2, 0, Math.PI * 2); ctx.fill();
    return;
  }
  for (let i = 1; i < st.length; i++) {
    const [x0, y0] = T(st[i - 1]), [x1, y1] = T(st[i]);
    ctx.lineWidth = ((st[i - 1].w + st[i].w) / 2) * s;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  }
}
