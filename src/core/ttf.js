// A from-scratch TrueType (glyf) font writer with OpenType layout.
//
// Tables: head hhea maxp OS/2 hmtx cmap loca glyf name post GSUB GPOS.
// GSUB supports lookup types 1 (single), 4 (ligature), 6 format 3 (chained
// context, coverage based). GPOS supports type 2 format 2 (class pair kerning).
//
// Input font description:
// {
//   family, style, version, designer,
//   metrics: { ascender, descender, xHeight, capHeight, italicAngle },
//   glyphs: [{ name, advance, contours: [[{x,y,on}]], unicodes: [cp] }],  // glyph 0 = .notdef
//   gsub: { lookups: [...], features: [{ tag, lookups: [i] }] } | null,
//   gpos: { lookups: [...], features: [{ tag, lookups: [i] }] } | null,
// }

class W {
  constructor(size = 1024) { this.buf = new Uint8Array(size); this.dv = new DataView(this.buf.buffer); this.n = 0; }
  ensure(k) {
    if (this.n + k <= this.buf.length) return;
    let s = this.buf.length * 2; while (s < this.n + k) s *= 2;
    const b = new Uint8Array(s); b.set(this.buf.subarray(0, this.n)); this.buf = b; this.dv = new DataView(b.buffer);
  }
  u8(v) { this.ensure(1); this.dv.setUint8(this.n, v); this.n += 1; return this; }
  i8(v) { this.ensure(1); this.dv.setInt8(this.n, v); this.n += 1; return this; }
  u16(v) {
    if (!(v >= 0 && v <= 0xFFFF)) throw new RangeError('u16 out of range: ' + v);
    this.ensure(2); this.dv.setUint16(this.n, v); this.n += 2; return this;
  }
  i16(v) {
    v = Math.round(v);
    if (!(v >= -32768 && v <= 32767)) throw new RangeError('i16 out of range: ' + v);
    this.ensure(2); this.dv.setInt16(this.n, v); this.n += 2; return this;
  }
  u32(v) { this.ensure(4); this.dv.setUint32(this.n, v >>> 0); this.n += 4; return this; }
  i32(v) { this.ensure(4); this.dv.setInt32(this.n, v | 0); this.n += 4; return this; }
  tag(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 32); return this; }
  bytes(b) { this.ensure(b.length); this.buf.set(b, this.n); this.n += b.length; return this; }
  pad4() { while (this.n % 4) this.u8(0); return this; }
  setU16(at, v) { this.dv.setUint16(at, v); }
  setU32(at, v) { this.dv.setUint32(at, v >>> 0); }
  done() { return this.buf.slice(0, this.n); }
}

/**
 * Lay out a header plus child blobs with uint16 offsets measured from the
 * start of the header. `head(offsets)` must write the header given offsets.
 */
function withChildren(headerSize, children, head) {
  const offsets = [];
  let at = headerSize;
  for (const c of children) { offsets.push(at); at += c.length; }
  const w = new W(at);
  head(w, offsets);
  if (w.n !== headerSize) throw new Error(`header size mismatch ${w.n} != ${headerSize}`);
  for (const c of children) w.bytes(c);
  if (offsets.some(o => o > 0xFFFF)) throw new RangeError('layout table exceeds 64K offsets');
  return w.done();
}

// ---------------------------------------------------------------- layout ---

// Coverage and ClassDef tables come in two formats each (a plain list/array, or
// ranges). Many glyph versions make one or the other much smaller, and layout
// subtables are limited to 64 KB of offsets, so always write the smaller one.
function coverage(gids) {
  const g = [...new Set(gids)].sort((a, b) => a - b);
  const ranges = [];
  for (let i = 0; i < g.length; i++) {
    const r = ranges[ranges.length - 1];
    if (r && r.end === g[i] - 1) r.end = g[i]; else ranges.push({ start: g[i], end: g[i], index: i });
  }
  let w;
  if (4 + ranges.length * 6 < 4 + g.length * 2) {
    w = new W(4 + ranges.length * 6);
    w.u16(2).u16(ranges.length);
    for (const r of ranges) w.u16(r.start).u16(r.end).u16(r.index);
  } else {
    w = new W(4 + g.length * 2);
    w.u16(1).u16(g.length);
    for (const x of g) w.u16(x);
  }
  return { bytes: w.done(), order: g };
}

function classDef(map) {
  // map: Map gid -> class (class 0 entries are omitted).
  const e = [...map.entries()].filter(([, c]) => c > 0).sort((a, b) => a[0] - b[0]);
  if (!e.length) { const w = new W(4); w.u16(2).u16(0); return w.done(); }
  const ranges = [];
  for (const [g, c] of e) {
    const r = ranges[ranges.length - 1];
    if (r && r.end === g - 1 && r.cls === c) r.end = g; else ranges.push({ start: g, end: g, cls: c });
  }
  const first = e[0][0], last = e[e.length - 1][0];
  const size1 = 6 + (last - first + 1) * 2, size2 = 4 + ranges.length * 6;
  if (size1 < size2) {
    const w = new W(size1);
    w.u16(1).u16(first).u16(last - first + 1);
    for (let g = first; g <= last; g++) w.u16(map.get(g) || 0);
    return w.done();
  }
  const w = new W(size2);
  w.u16(2).u16(ranges.length);
  for (const r of ranges) w.u16(r.start).u16(r.end).u16(r.cls);
  return w.done();
}

function singleSubst(st) {
  const cov = coverage([...st.map.keys()]);
  const n = cov.order.length;
  return withChildren(6 + 2 * n, [cov.bytes], (w, [covOff]) => {
    w.u16(2).u16(covOff).u16(n);
    for (const g of cov.order) w.u16(st.map.get(g));
  });
}

function ligatureSubst(st) {
  // st.ligs: [{ first, rest:[gid], glyph }]
  const byFirst = new Map();
  for (const l of st.ligs) {
    if (!byFirst.has(l.first)) byFirst.set(l.first, []);
    byFirst.get(l.first).push(l);
  }
  const cov = coverage([...byFirst.keys()]);
  const sets = cov.order.map(first => {
    const ligs = byFirst.get(first).sort((a, b) => b.rest.length - a.rest.length);
    const ligBlobs = ligs.map(l => {
      const w = new W(); w.u16(l.glyph).u16(l.rest.length + 1); for (const g of l.rest) w.u16(g); return w.done();
    });
    return withChildren(2 + 2 * ligBlobs.length, ligBlobs, (w, offs) => { w.u16(ligBlobs.length); for (const o of offs) w.u16(o); });
  });
  return withChildren(6 + 2 * sets.length, [cov.bytes, ...sets], (w, [covOff, ...setOffs]) => {
    w.u16(1).u16(covOff).u16(sets.length); for (const o of setOffs) w.u16(o);
  });
}

function chainContext3(st) {
  // st: { backtrack: [[gid]], input: [[gid]], lookahead: [[gid]], records: [{ seq, lookup }] }
  const covs = [...st.backtrack, ...st.input, ...st.lookahead].map(g => coverage(g).bytes);
  const nb = st.backtrack.length, ni = st.input.length, nl = st.lookahead.length, nr = st.records.length;
  const header = 2 + 2 + 2 * nb + 2 + 2 * ni + 2 + 2 * nl + 2 + 4 * nr;
  return withChildren(header, covs, (w, offs) => {
    w.u16(3);
    w.u16(nb); for (let i = 0; i < nb; i++) w.u16(offs[i]);
    w.u16(ni); for (let i = 0; i < ni; i++) w.u16(offs[nb + i]);
    w.u16(nl); for (let i = 0; i < nl; i++) w.u16(offs[nb + ni + i]);
    w.u16(nr); for (const r of st.records) w.u16(r.seq).u16(r.lookup);
  });
}

/**
 * Chained context substitution, format 2 (class based). Scales to many
 * versions: one subtable, rules grouped per input class.
 * st: { coverage: [gid], backtrackClasses: Map gid->class, inputClasses: Map gid->class,
 *       inputClassCount, rules: [{ input: class, backtrack: [class...], lookup }] }
 */
function chainContext2(st) {
  const cov = coverage(st.coverage);
  const btCD = classDef(st.backtrackClasses);
  const inCD = classDef(st.inputClasses);
  const laCD = classDef(new Map());
  const nSets = st.inputClassCount; // classes 0..n-1
  const byClass = Array.from({ length: nSets }, () => []);
  for (const r of st.rules) byClass[r.input].push(r);
  const setBlobs = byClass.map(rules => {
    if (!rules.length) return null;
    const ruleBlobs = rules.map(r => {
      const w = new W();
      w.u16(r.backtrack.length); for (const c of r.backtrack) w.u16(c);
      w.u16(1);                 // input glyph count (just the current glyph)
      w.u16(0);                 // lookahead count
      w.u16(1).u16(0).u16(r.lookup);
      return w.done();
    });
    return withChildren(2 + 2 * ruleBlobs.length, ruleBlobs, (w, offs) => { w.u16(ruleBlobs.length); for (const o of offs) w.u16(o); });
  });
  const children = [cov.bytes, btCD, inCD, laCD, ...setBlobs.filter(Boolean)];
  return withChildren(12 + 2 * nSets, children, (w, offs) => {
    const [covOff, btOff, inOff, laOff, ...setOffs] = offs;
    w.u16(2).u16(covOff).u16(btOff).u16(inOff).u16(laOff).u16(nSets);
    let k = 0;
    for (const s of setBlobs) w.u16(s ? setOffs[k++] : 0);
  });
}

function pairPos2(st) {
  // st: { classDef1: Map, classDef2: Map, class1Count, class2Count, values: Int16Array(c1*c2) }
  const cov = coverage([...st.classDef1.keys()]);
  const cd1 = classDef(st.classDef1);
  // Left and right classes are usually identical: store the table once.
  const same = st.classDef1 === st.classDef2;
  const cd2 = same ? null : classDef(st.classDef2);
  const matrix = st.class1Count * st.class2Count * 2;
  const header = 16 + matrix;
  return withChildren(header, same ? [cov.bytes, cd1] : [cov.bytes, cd1, cd2], (w, [covOff, cd1Off, cd2Off]) => {
    w.u16(2).u16(covOff).u16(0x0004).u16(0).u16(cd1Off).u16(same ? cd1Off : cd2Off).u16(st.class1Count).u16(st.class2Count);
    for (let i = 0; i < st.class1Count * st.class2Count; i++) w.i16(st.values[i]);
  });
}

const SUBTABLE = {
  GSUB: { 1: singleSubst, 4: ligatureSubst, 6: st => (st.format === 2 ? chainContext2(st) : chainContext3(st)) },
  GPOS: { 2: pairPos2 },
};

function layoutTable(kind, spec) {
  const lookups = spec.lookups.map(lk => {
    const subs = lk.subtables.map(st => SUBTABLE[kind][lk.type](st));
    return withChildren(6 + 2 * subs.length, subs, (w, offs) => {
      w.u16(lk.type).u16(lk.flag || 0).u16(subs.length); for (const o of offs) w.u16(o);
    });
  });
  const lookupList = withChildren(2 + 2 * lookups.length, lookups, (w, offs) => { w.u16(lookups.length); for (const o of offs) w.u16(o); });

  const feats = spec.features.slice().sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const featBlobs = feats.map(f => { const w = new W(); w.u16(0).u16(f.lookups.length); for (const i of f.lookups) w.u16(i); return w.done(); });
  const featureList = withChildren(2 + 6 * feats.length, featBlobs, (w, offs) => {
    w.u16(feats.length); feats.forEach((f, i) => w.tag(f.tag).u16(offs[i]));
  });

  const langSys = (() => { const w = new W(); w.u16(0).u16(0xFFFF).u16(feats.length); feats.forEach((_, i) => w.u16(i)); return w.done(); })();
  const script = withChildren(4, [langSys], (w, [o]) => w.u16(o).u16(0));
  const scripts = ['DFLT', 'latn'];
  const scriptList = withChildren(2 + 6 * scripts.length, scripts.map(() => script), (w, offs) => {
    w.u16(scripts.length); scripts.forEach((t, i) => w.tag(t).u16(offs[i]));
  });

  return withChildren(10, [scriptList, featureList, lookupList], (w, [s, f, l]) => {
    w.u16(1).u16(0).u16(s).u16(f).u16(l);
  });
}

// ------------------------------------------------------------- glyph data ---

function encodeGlyph(g) {
  if (!g.contours || !g.contours.length) return new Uint8Array(0);
  const pts = g.contours.flat();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const w = new W(16 + pts.length * 6);
  w.i16(g.contours.length).i16(x0).i16(y0).i16(x1).i16(y1);
  let end = -1;
  for (const c of g.contours) { end += c.length; w.u16(end); }
  w.u16(0); // no hinting instructions
  const flags = [], xs = new W(), ys = new W();
  let px = 0, py = 0;
  for (const p of pts) {
    let f = p.on ? 1 : 0;
    const dx = p.x - px, dy = p.y - py; px = p.x; py = p.y;
    if (dx === 0) f |= 0x10;
    else if (Math.abs(dx) < 256) { f |= 0x02; if (dx > 0) f |= 0x10; xs.u8(Math.abs(dx)); }
    else xs.i16(dx);
    if (dy === 0) f |= 0x20;
    else if (Math.abs(dy) < 256) { f |= 0x04; if (dy > 0) f |= 0x20; ys.u8(Math.abs(dy)); }
    else ys.i16(dy);
    flags.push(f);
  }
  // Run-length compress flags with the REPEAT bit.
  for (let i = 0; i < flags.length;) {
    let j = i + 1;
    while (j < flags.length && flags[j] === flags[i] && j - i < 256) j++;
    const run = j - i;
    if (run > 2) { w.u8(flags[i] | 0x08).u8(run - 1); i = j; } else { w.u8(flags[i]); i++; }
  }
  w.bytes(xs.done()).bytes(ys.done());
  while (w.n % 4) w.u8(0);
  return w.done();
}

function glyphBounds(g) {
  let x0 = 0, y0 = 0, x1 = 0, y1 = 0, first = true;
  for (const c of g.contours || []) for (const p of c) {
    if (first) { x0 = x1 = p.x; y0 = y1 = p.y; first = false; continue; }
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, empty: first };
}

// ------------------------------------------------------------ font tables ---

function utf16be(s) {
  const w = new W(); for (const ch of s) { const c = ch.codePointAt(0); if (c > 0xFFFF) { const v = c - 0x10000; w.u16(0xD800 + (v >> 10)).u16(0xDC00 + (v & 0x3FF)); } else w.u16(c); } return w.done();
}

function nameTable(names) {
  const ids = Object.keys(names).map(Number).sort((a, b) => a - b);
  const strs = ids.map(id => utf16be(names[id]));
  const w = new W();
  w.u16(0).u16(ids.length).u16(6 + ids.length * 12);
  let off = 0;
  ids.forEach((id, i) => { w.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i].length).u16(off); off += strs[i].length; });
  for (const s of strs) w.bytes(s);
  return w.done();
}

function cmapTable(map) {
  // map: [[codepoint, gid]] BMP only, format 4 with merged runs.
  const e = map.filter(([c]) => c <= 0xFFFF).sort((a, b) => a[0] - b[0]);
  const segs = [];
  for (const [c, g] of e) {
    const s = segs[segs.length - 1];
    if (s && s.end === c - 1 && s.delta === ((g - c) & 0xFFFF)) s.end = c;
    else segs.push({ start: c, end: c, delta: (g - c) & 0xFFFF });
  }
  segs.push({ start: 0xFFFF, end: 0xFFFF, delta: 1 });
  const n = segs.length;
  const lg = Math.floor(Math.log2(n));
  const searchRange = 2 * (1 << lg);
  const sub = new W();
  sub.u16(4).u16(16 + n * 8).u16(0).u16(n * 2).u16(searchRange).u16(lg).u16(n * 2 - searchRange);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.u16(s.delta);
  for (let i = 0; i < n; i++) sub.u16(0);
  const subtable = sub.done();
  const w = new W();
  w.u16(0).u16(2);
  w.u16(0).u16(3).u32(20);  // Unicode BMP
  w.u16(3).u16(1).u32(20);  // Windows Unicode BMP
  w.bytes(subtable);
  return w.done();
}

function checksum(bytes) {
  let s = 0;
  const n = bytes.length;
  for (let i = 0; i < n; i += 4) {
    s = (s + (((bytes[i] << 24) | ((bytes[i + 1] || 0) << 16) | ((bytes[i + 2] || 0) << 8) | (bytes[i + 3] || 0)) >>> 0)) >>> 0;
  }
  return s;
}

export function writeTTF(font) {
  const { glyphs } = font;
  const m = font.metrics;
  const numGlyphs = glyphs.length;
  if (numGlyphs > 65535) throw new RangeError('too many glyphs');

  // glyf + loca
  const glyf = new W();
  const loca = new W();
  let maxPoints = 0, maxContours = 0;
  let xMin = 0, yMin = 0, xMax = 0, yMax = 0, any = false;
  let advMax = 0, minLsb = 32767, minRsb = 32767, maxExtent = 0, advSum = 0, advCount = 0;
  const hmtx = new W();
  for (const g of glyphs) {
    loca.u32(glyf.n);
    glyf.bytes(encodeGlyph(g));
    const b = glyphBounds(g);
    const pts = (g.contours || []).reduce((a, c) => a + c.length, 0);
    maxPoints = Math.max(maxPoints, pts);
    maxContours = Math.max(maxContours, (g.contours || []).length);
    const adv = Math.max(0, Math.round(g.advance));
    advMax = Math.max(advMax, adv);
    if (adv > 0) { advSum += adv; advCount++; }
    hmtx.u16(adv).i16(b.empty ? 0 : b.x0);
    if (!b.empty) {
      if (!any) { xMin = b.x0; yMin = b.y0; xMax = b.x1; yMax = b.y1; any = true; }
      xMin = Math.min(xMin, b.x0); yMin = Math.min(yMin, b.y0); xMax = Math.max(xMax, b.x1); yMax = Math.max(yMax, b.y1);
      minLsb = Math.min(minLsb, b.x0); minRsb = Math.min(minRsb, adv - b.x1); maxExtent = Math.max(maxExtent, b.x1);
    }
  }
  loca.u32(glyf.n);
  if (minLsb === 32767) minLsb = 0;
  if (minRsb === 32767) minRsb = 0;

  const asc = Math.max(m.ascender, yMax);
  const desc = Math.min(m.descender, yMin); // negative
  const lineGap = Math.max(0, Math.round(1.2 * 1000 - (asc - desc)));

  const now = Math.floor(Date.now() / 1000) + 2082844800;
  const head = new W();
  head.u32(0x00010000).u32(Math.round((font.versionNumber || 1) * 65536)).u32(0).u32(0x5F0F3CF5)
    .u16(0x000B).u16(1000)
    .u32(Math.floor(now / 4294967296)).u32(now >>> 0).u32(Math.floor(now / 4294967296)).u32(now >>> 0)
    .i16(xMin).i16(yMin).i16(xMax).i16(yMax)
    .u16(m.italicAngle ? 0x02 : 0).u16(8).i16(2).i16(1).i16(0);

  const hhea = new W();
  hhea.u32(0x00010000).i16(asc).i16(desc).i16(lineGap).u16(advMax).i16(minLsb).i16(minRsb).i16(maxExtent)
    .i16(m.italicAngle ? 1000 : 1).i16(m.italicAngle ? Math.round(Math.tan((-m.italicAngle * Math.PI) / 180) * 1000) : 0)
    .i16(0).i16(0).i16(0).i16(0).i16(0).i16(0).u16(numGlyphs);

  const maxp = new W();
  maxp.u32(0x00010000).u16(numGlyphs).u16(maxPoints).u16(maxContours).u16(0).u16(0)
    .u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0);

  // cmap
  const cmapEntries = [];
  glyphs.forEach((g, gid) => (g.unicodes || []).forEach(cp => cmapEntries.push([cp, gid])));
  const cps = cmapEntries.map(e => e[0]);
  const firstChar = cps.length ? Math.min(...cps) : 0x20, lastChar = cps.length ? Math.max(...cps) : 0x20;
  let maxContext = 1;
  for (const l of font.maxContextHint ? [font.maxContextHint] : []) maxContext = Math.max(maxContext, l);

  const os2 = new W();
  const xAvg = advCount ? Math.round(advSum / advCount) : 500;
  const ur1 = 1 | (cps.some(c => c >= 0x2000 && c <= 0x206F) ? 1 << 31 : 0);
  os2.u16(4).i16(xAvg).u16(font.weightClass || 400).u16(5).u16(0)
    .i16(650).i16(600).i16(0).i16(75).i16(650).i16(600).i16(0).i16(350)
    .i16(50).i16(Math.round(m.xHeight * 0.55)).i16(0);
  for (let i = 0; i < 10; i++) os2.u8(i === 0 ? 3 : 0); // panose: family kind = handwritten (3)
  os2.u32(ur1).u32(0).u32(0).u32(0).tag('INKF')
    .u16(m.italicAngle ? 0x01 : 0x40)
    .u16(Math.min(firstChar, 0xFFFF)).u16(Math.min(lastChar, 0xFFFF))
    .i16(m.ascender).i16(m.descender).i16(lineGap)
    .u16(Math.max(0, asc)).u16(Math.max(0, -desc))
    .u32(1).u32(0)
    .i16(m.xHeight).i16(m.capHeight).u16(0).u16(32).u16(maxContext);

  const post = new W();
  post.u32(0x00030000).i32(Math.round((m.italicAngle || 0) * 65536)).i16(-120).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0);

  const family = font.family || 'Inkforge Hand';
  const style = font.style || 'Regular';
  const psName = (family + '-' + style).replace(/[^A-Za-z0-9-]/g, '').slice(0, 63) || 'InkforgeHand-Regular';
  const name = nameTable({
    0: font.copyright || `Created with Inkforge`,
    1: family, 2: style, 3: `Inkforge:${psName}:${now}`, 4: `${family} ${style}`,
    5: `Version ${(font.versionNumber || 1).toFixed(3)}`, 6: psName,
    ...(font.designer ? { 9: font.designer } : {}),
    11: 'https://github.com/', 13: font.license || 'All rights reserved by the handwriting owner.',
  });

  const tables = {
    'OS/2': os2.done(), cmap: cmapTable(cmapEntries), glyf: glyf.done(), head: head.done(), hhea: hhea.done(),
    hmtx: hmtx.done(), loca: loca.done(), maxp: maxp.done(), name, post: post.done(),
  };
  if (font.gsub && font.gsub.lookups.length) tables.GSUB = layoutTable('GSUB', font.gsub);
  if (font.gpos && font.gpos.lookups.length) tables.GPOS = layoutTable('GPOS', font.gpos);

  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const lg = Math.floor(Math.log2(n));
  const out = new W();
  out.u32(0x00010000).u16(n).u16(16 * (1 << lg)).u16(lg).u16(n * 16 - 16 * (1 << lg));
  let offset = 12 + 16 * n;
  const recPos = {};
  for (const t of tags) {
    recPos[t] = out.n;
    out.tag(t).u32(checksum(tables[t])).u32(offset).u32(tables[t].length);
    offset += (tables[t].length + 3) & ~3;
  }
  let headOffset = 0;
  for (const t of tags) {
    if (t === 'head') headOffset = out.n;
    out.bytes(tables[t]).pad4();
  }
  const bytes = out.done();
  const adj = (0xB1B0AFBA - checksum(bytes)) >>> 0;
  new DataView(bytes.buffer).setUint32(headOffset + 8, adj);
  return bytes;
}
