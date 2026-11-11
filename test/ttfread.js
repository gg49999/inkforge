// Minimal independent TrueType reader used to verify what ttf.js writes.

export function readTTF(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = o => dv.getUint16(o), i16 = o => dv.getInt16(o), u32 = o => dv.getUint32(o);
  const tag = o => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  const n = u16(4);
  const tables = {};
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    tables[tag(r)] = { checksum: u32(r + 4), offset: u32(r + 8), length: u32(r + 12) };
  }
  const sum = (off, len) => { let s = 0; for (let i = 0; i < len; i += 4) { let v = 0; for (let k = 0; k < 4; k++) v = (v << 8) | (i + k < len ? bytes[off + i + k] : 0); s = (s + (v >>> 0)) >>> 0; } return s; };
  const errors = [];
  for (const [t, r] of Object.entries(tables)) {
    if (r.offset % 4) errors.push(`${t} not 4-aligned`);
    if (r.offset + r.length > bytes.length) errors.push(`${t} out of bounds`);
    let c = sum(r.offset, r.length);
    if (t === 'head') c = (c - u32(r.offset + 8)) >>> 0;
    if (c !== r.checksum) errors.push(`${t} checksum mismatch`);
  }
  if (sum(0, bytes.length) !== 0xB1B0AFBA) errors.push('whole-font checksum adjustment wrong');
  const head = tables.head.offset;
  if (u32(head + 12) !== 0x5F0F3CF5) errors.push('bad head magic');
  const numGlyphs = u16(tables.maxp.offset + 4);
  const locFmt = i16(head + 50);
  const loca = i => locFmt ? u32(tables.loca.offset + i * 4) : u16(tables.loca.offset + i * 2) * 2;
  const glyf = tables.glyf.offset;
  const nHM = u16(tables.hhea.offset + 34);
  const glyphs = [];
  for (let g = 0; g < numGlyphs; g++) {
    const start = loca(g), end = loca(g + 1);
    const adv = u16(tables.hmtx.offset + Math.min(g, nHM - 1) * 4);
    if (end < start) errors.push(`loca not monotonic at ${g}`);
    if (end === start) { glyphs.push({ advance: adv, contours: [] }); continue; }
    let p = glyf + start;
    const nc = i16(p); p += 10;
    const ends = []; for (let i = 0; i < nc; i++) { ends.push(u16(p)); p += 2; }
    const il = u16(p); p += 2 + il;
    const np = ends[nc - 1] + 1;
    const flags = [];
    while (flags.length < np) { const f = bytes[p++]; flags.push(f); if (f & 8) { const r = bytes[p++]; for (let k = 0; k < r; k++) flags.push(f); } }
    const xs = [], ys = [];
    let x = 0; for (const f of flags) { if (f & 2) { const d = bytes[p++]; x += f & 0x10 ? d : -d; } else if (!(f & 0x10)) { x += i16(p); p += 2; } xs.push(x); }
    let y = 0; for (const f of flags) { if (f & 4) { const d = bytes[p++]; y += f & 0x20 ? d : -d; } else if (!(f & 0x20)) { y += i16(p); p += 2; } ys.push(y); }
    if (p > glyf + end) errors.push(`glyph ${g} overruns its loca slot`);
    const contours = []; let s = 0;
    for (const e of ends) { contours.push(xs.slice(s, e + 1).map((xx, i) => ({ x: xx, y: ys[s + i], on: !!(flags[s + i] & 1) }))); s = e + 1; }
    glyphs.push({ advance: adv, contours });
  }
  // cmap format 4
  const cmap = new Map();
  const cm = tables.cmap.offset;
  for (let i = 0; i < u16(cm + 2); i++) {
    const pid = u16(cm + 4 + i * 8), eid = u16(cm + 6 + i * 8), off = u32(cm + 8 + i * 8);
    if (pid !== 3 || eid !== 1) continue;
    const st = cm + off;
    const segX2 = u16(st + 6), segs = segX2 / 2;
    const endA = st + 14, startA = endA + segX2 + 2, deltaA = startA + segX2, roA = deltaA + segX2;
    for (let k = 0; k < segs; k++) {
      const e = u16(endA + k * 2), s0 = u16(startA + k * 2), d = u16(deltaA + k * 2), ro = u16(roA + k * 2);
      if (ro) errors.push('unexpected idRangeOffset');
      for (let c = s0; c <= e && c !== 0xFFFF; c++) cmap.set(c, (c + d) & 0xFFFF);
    }
  }
  return { tables, numGlyphs, glyphs, cmap, errors };
}
