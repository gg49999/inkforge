// Node test runner: `node test/run.js`
import { writeFileSync, mkdirSync } from 'node:fs';
import { isoContours, signedArea, traceField } from '../src/core/trace.js';
import { field, edt, mask, components, threshold } from '../src/core/raster.js';
import { buildFont, computeKerning } from '../src/core/fontbuilder.js';
import { writeTTF } from '../src/core/ttf.js';
import { demoSamples, strokesToSample, ellipse } from '../src/core/synth.js';
import { readTTF } from './ttfread.js';
import { PAGES, FIDUCIALS, homography, readSheet, cellRect, gapSheets } from '../src/core/template.js';
import { analyzeInk } from '../src/core/analyze.js';
import { makeFillIns } from '../src/core/fillin.js';
import { imagesToPDF } from '../src/core/pdf.js';
import { versionChain } from '../src/core/versions.js';
import { train as learnTrain, generate as learnGenerate } from '../src/core/learn.js';
import { demoLibrary } from '../src/core/writers.js';
import { rng, hashString } from '../src/core/raster.js';
import { CHARSET } from '../src/core/constants.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ok  ', name); }
  catch (e) { fail++; console.log('  FAIL', name, '\n       ', e.stack.split('\n').slice(0, 3).join('\n        ')); }
}
function assert(c, msg) { if (!c) throw new Error(msg || 'assertion failed'); }

test('iso contours of a ring: outer + hole with opposite winding', () => {
  const w = 40, h = 40, f = field(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 20, y - 20);
    f.data[y * w + x] = d < 14 && d > 7 ? 1 : 0;
  }
  const cs = isoContours(f);
  assert(cs.length === 2, 'expected 2 contours, got ' + cs.length);
  const areas = cs.map(signedArea).sort((a, b) => a - b);
  assert(areas[0] < 0 && areas[1] > 0, 'windings ' + areas);
  assert(Math.abs(areas[0]) > Math.abs(areas[1]), 'outer (ink-left) should be the larger, negative one');
});

test('trace simplifies dense contours', () => {
  const s = strokesToSample('o', [ellipse(220, 250, 180, 240)]);
  const polys = traceField(field(s.w, s.h, s.ink));
  assert(polys.length === 2, 'o should have 2 contours, got ' + polys.length);
  assert(polys.every(p => p.length < 80), 'simplified point counts ' + polys.map(p => p.length));
});

test('distance transform', () => {
  const m = mask(9, 9); for (let y = 2; y < 7; y++) for (let x = 2; x < 7; x++) m.data[y * 9 + x] = 1;
  const d = edt(m);
  assert(Math.abs(d.data[4 * 9 + 4] - 3) < 1e-6, 'center distance ' + d.data[40]);
});

test('components', () => {
  const m = mask(10, 3, Uint8Array.from([1,1,0,0,0,0,0,1,1,1, 0,0,0,0,0,0,0,0,0,0, 0,0,0,0,1,0,0,0,0,0]));
  assert(components(m).comps.length === 3);
});

let built;
test('build font from demo hand', () => {
  built = buildFont(demoSamples(), { family: 'Inkforge Test', variants: 4 });
  assert(built.stats.characters === 12, 'chars ' + built.stats.characters);
  assert(built.stats.ligatures === 1, 'ligatures');
  assert(built.font.gsub && built.font.gpos, 'layout tables');
});

test('TTF round-trips through an independent reader', () => {
  const bytes = writeTTF(built.font);
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  writeFileSync(new URL('./out/test.ttf', import.meta.url), bytes);
  const r = readTTF(bytes);
  assert(!r.errors.length, r.errors.join('; '));
  assert(r.numGlyphs === built.font.glyphs.length, 'glyph count');
  const gid = r.cmap.get('o'.charCodeAt(0));
  assert(gid > 1, 'cmap o');
  const src = built.font.glyphs[gid];
  assert(JSON.stringify(r.glyphs[gid].contours) === JSON.stringify(src.contours.map(c => c.map(p => ({ x: p.x, y: p.y, on: p.on })))), 'outline mismatch');
  for (const t of ['GSUB', 'GPOS', 'OS/2', 'cmap', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) assert(r.tables[t], 'missing ' + t);
});

test('outer contours are clockwise in font space (TrueType rule)', () => {
  const gid = built.glyphInfo.find(g => g.char === 'o').gid;
  const cs = built.font.glyphs[gid].contours;
  // In y-up space, shoelace > 0 means counter-clockwise.
  const a = cs.map(c => signedArea(c)).sort((x, y) => Math.abs(y) - Math.abs(x));
  assert(a[0] < 0, 'outer should be clockwise (negative), got ' + a[0]);
  assert(a[1] > 0, 'hole should be counter-clockwise');
});

test('optical kerning tucks o under T', () => {
  const r = readTTF(writeTTF(built.font));
  assert(built.stats.kernPairs > 0, 'no kern pairs');
  // Re-derive from builder internals: pair T|o must be negative.
  const bases = new Map(built.glyphInfo.filter(g => g.version === 0 && !g.ligature).map(g => [g.char, g.outline]));
  const k = computeKerning(bases, built.settings);
  assert((k.get('T|o') || 0) < -20, 'T|o = ' + k.get('T|o'));
  assert((k.get('A|V') || 0) < -20, 'A|V = ' + k.get('A|V'));
  assert(!r.errors.length);
});

test('variants: every char has distinct versions', () => {
  const os = built.glyphInfo.filter(g => g.char === 'o');
  assert(os.length === 4, 'versions ' + os.length);
  const sigs = new Set(os.map(g => JSON.stringify(g.outline.contours)));
  assert(sigs.size === 4, 'versions should differ');
});

test('handwriting analysis on synthetic slanted lines', () => {
  // Draw two lines of "nnnn oooo" slanted ~15 degrees into one page field.
  const W = 900, H = 470, f = field(W, H);
  const sh = Math.tan(15 * Math.PI / 180);
  const stamp = (s, ox, base) => {
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const v = s.ink[y * s.w + x]; if (!v) continue;
      const yy = Math.round(base - s.baseline + y), xx = Math.round(ox + x + (s.baseline - y) * sh);
      if (yy >= 0 && yy < H && xx >= 0 && xx < W) f.data[yy * W + xx] = Math.max(f.data[yy * W + xx], v);
    }
  };
  const n = strokesToSample('n', [[{ x: 60, y: 0 }, { x: 60, y: 500 }], [{ x: 60, y: 380 }, ...ellipse(220, 360, 160, 140, 16, Math.PI, 0).slice(1), { x: 380, y: 0 }]]);
  const l = strokesToSample('l', [[{ x: 80, y: 780 }, { x: 80, y: 0 }]]);
  for (const base of [190, 410]) {
    let x = 20;
    for (const ch of 'nlnn nlln nl') { if (ch === ' ') { x += 70; continue; } const s = ch === 'n' ? n : l; stamp(s, x, base); x += s.w + 12; }
  }
  const a = analyzeInk(f);
  assert(a.lines.length === 2, 'lines ' + a.lines.length);
  assert(Math.abs(a.slant - 15) < 4, 'slant ' + a.slant);
  assert(a.xHeight > 90 && a.xHeight < 150, 'xHeight px ' + a.xHeight);
  assert(a.strokeWidth > 10 && a.strokeWidth < 20, 'stroke ' + a.strokeWidth);
});

test('fill-ins cover every missing character and yield to real samples', () => {
  const real = demoSamples();
  const fills = makeFillIns(CHARSET, real);
  const have = new Set([...real, ...fills].map(s => s.char));
  const uncovered = [...CHARSET].filter(c => !have.has(c));
  assert(!uncovered.length, 'uncovered: ' + uncovered.join(''));
  assert(!fills.some(s => s.char === 'o'), 'should not fill a letter that has a real sample');
  // A real sample added later wins over the fill-in.
  const realX = strokesToSample('x', [[{ x: 0, y: 0 }, { x: 300, y: 500 }]], { source: 'pad', id: 'real-x' });
  const b = buildFont([...real, ...fills, realX], { variants: 1 });
  const xg = b.glyphInfo.find(g => g.char === 'x');
  assert(xg.sampleId === 'real-x', 'x came from ' + xg.sampleId);
  const r = readTTF(writeTTF(b.font));
  assert(!r.errors.length, r.errors.join(';'));
});

test('digits get more versions than letters, font stays valid', () => {
  const real = demoSamples();
  const fills = makeFillIns(CHARSET, real);
  const b = buildFont([...real, ...fills], { variants: 8, digitVariants: 12 });
  const count = ch => b.glyphInfo.filter(g => g.char === ch).length;
  assert(count('3') === 12 && count('a') === 8, `3:${count('3')} a:${count('a')}`);
  // Fill-in digits: every version is its own drawing, not a warp of another.
  const fromDistinct = new Set(b.glyphInfo.filter(g => g.char === '3').map(g => g.sampleId));
  assert(fromDistinct.size === 12, 'distinct drawings ' + fromDistinct.size);
  const r = readTTF(writeTTF(b.font));
  assert(!r.errors.length, r.errors.join(';'));
});

test('30 versions per character: compact switching table, valid font', () => {
  const real = demoSamples();
  const fills = makeFillIns(CHARSET, real, { copies: 6, digitCopies: 6 });
  const b = buildFont([...real, ...fills], { variants: 30, digitVariants: 30 });
  const count = ch => b.glyphInfo.filter(g => g.char === ch).length;
  assert(count('a') === 30 && count('7') === 30 && count('o') === 30, `a:${count('a')} 7:${count('7')} o:${count('o')}`);
  const bytes = writeTTF(b.font);
  const r = readTTF(bytes);
  assert(!r.errors.length, r.errors.join(';'));
  assert(r.numGlyphs > 2800, 'glyphs ' + r.numGlyphs);
});

test('version formula: repeated letters visit every version, repeated words differ', () => {
  const n = () => 30;
  const a = versionChain('a'.repeat(31), n);
  assert(new Set(a.slice(1)).size === 30, 'aaaa... should visit all 30 versions, got ' + new Set(a.slice(1)).size);
  for (let i = 1; i < a.length; i++) assert(a[i] !== a[i - 1], 'no immediate repeats');
  const words = 'the cat and the dog and the bird and the fish'.split(' ');
  const chain = versionChain(words.join(' '), n);
  // Collect the version pattern of each occurrence of "the".
  let pos = 0; const thes = [];
  for (const w of words) { if (w === 'the') thes.push(chain.slice(pos, pos + 3).join(',')); pos += w.length + 1; }
  assert(new Set(thes).size === thes.length, 'every "the" should be drawn differently: ' + thes.join(' | '));
});

test('learned model: finds the main variation and generates within it', () => {
  // Eight 'o's whose width varies: the model should find that as its main mode.
  const os = [];
  for (let i = 0; i < 8; i++) {
    const s = strokesToSample('o', [ellipse(220, 250, 120 + i * 15, 240, 40)], { id: 'o' + i });
    s.source = 'pad'; os.push(s);
  }
  const model = learnTrain(os);
  const e = model.chars.get('o');
  assert(e.modes.length >= 1, 'no modes');
  assert(e.vars[0] > 10 * (e.vars[1] || 0.001), 'width should dominate: ' + e.vars.slice(0, 3).map(v => v.toFixed(1)));
  const width = s => { let x0 = 1e9, x1 = -1; for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) if (s.ink[y * s.w + x] > 0.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } return x1 - x0; };
  const gens = Array.from({ length: 30 }, (_, i) => learnGenerate(model, 'o', i, { key: 'test' }));
  assert(gens.every(Boolean), 'all generated');
  const ws = gens.map(width), tw = os.map(width);
  const lo = Math.min(...tw), hi = Math.max(...tw), span = hi - lo;
  assert(ws.filter(w => w >= lo - span * 0.4 && w <= hi + span * 0.4).length >= 27, 'generated widths should follow training: ' + ws.join(','));
  assert(new Set(ws).size > 10, 'generated copies should differ');
});

test('font build uses learned copies for extra versions', () => {
  const real = demoSamples();
  const b = buildFont(real, { variants: 6, learned: true });
  const learned = b.glyphInfo.filter(g => g.synthetic === 'learned');
  assert(learned.length > 0, 'expected learned versions');
  const r = readTTF(writeTTF(b.font));
  assert(!r.errors.length, r.errors.join(';'));
});

test('64 versions per character: font fits the format limits', () => {
  const lib = demoLibrary(CHARSET, ch => rng(hashString('t64:' + ch)));
  const fills = makeFillIns(CHARSET, lib, { copies: 2, digitCopies: 2 });
  const b = buildFont([...lib, ...fills], { variants: 64, digitVariants: 64, learned: false });
  const count = ch => b.glyphInfo.filter(g => g.char === ch).length;
  assert(count('a') === 64 && count('7') === 64, `a:${count('a')} 7:${count('7')}`);
  const r = readTTF(writeTTF(b.font)); // throws if any layout table overflowed
  assert(!r.errors.length, r.errors.join(';'));
  assert(r.numGlyphs > 6000, 'glyphs ' + r.numGlyphs);
});

test('PDF writer: valid structure and xref offsets', () => {
  const fakeJpeg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]);
  const pdf = imagesToPDF([{ jpeg: fakeJpeg, width: 10, height: 13 }, { jpeg: fakeJpeg, width: 10, height: 13 }], { title: 'Test (1)' });
  const s = Buffer.from(pdf).toString('latin1');
  assert(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'), 'header/trailer');
  const startxref = +s.match(/startxref\n(\d+)/)[1];
  assert(s.slice(startxref, startxref + 4) === 'xref', 'startxref points at xref');
  const entries = [...s.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => +m[1]);
  assert(entries.length === 9, 'objects ' + entries.length);
  entries.forEach((off, i) => assert(s.slice(off).startsWith(`${i + 1} 0 obj`), `object ${i + 1} offset`));
  assert(/\/Count 2/.test(s) && /\/Title \(Test \\\(1\\\)\)/.test(s), 'pages + escaped title');
});

test('gap-filler sheets prioritize missing characters', () => {
  const counts = new Map([['a', 3], ['b', 1], ['A', 2]]);
  const sheets = gapSheets(counts, 'abjAX3.');
  assert(sheets.length === 1 && sheets[0].index === PAGES.length, 'index ' + sheets[0]?.index);
  // missing: j(3) 3(3) X(2) .(1) then thin: b(2)
  assert(sheets[0].cells.join('') === 'jjj333XX.bb', sheets[0].cells.join(''));
});

test('template sheet: read a custom gap-filler sheet by its page code', () => {
  readSyntheticSheet(5, ['x', 'j', 'Q'], [{ index: 5, title: 'gap', cells: ['x', 'j', 'Q'] }]);
});

function readSyntheticSheet(page, cells, extraPages) {
  const photo = [{ x: 140, y: 120 }, { x: 1300, y: 170 }, { x: 1250, y: 1640 }, { x: 90, y: 1580 }];
  const toTpl = homography(photo, FIDUCIALS);
  const W = 1400, H = 1750, lum = field(W, H);
  const stamps = cells.map((ch, i) => ({ i, s: strokesToSample(ch, [[{ x: 40, y: 0 }, { x: 300, y: 700 }, { x: 560, y: 0 }]], { penWidth: 70 }) }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = toTpl(x, y);
    let v = 0.9;
    for (const f of FIDUCIALS) if (Math.abs(t.x - f.x) < 300 && Math.abs(t.y - f.y) < 300) v = 0.08;
    for (let k = 0; k < 6; k++) {
      const bit = k < 5 ? (page >> k) & 1 : [0, 1, 2, 3, 4].reduce((a, j) => a ^ ((page >> j) & 1), 0);
      if (bit && Math.abs(t.x - (6200 + (k - 2.5) * 450)) < 150 && Math.abs(t.y + 500) < 150) v = 0.08;
    }
    for (const { i, s } of stamps) {
      const r = cellRect(i);
      const px = (t.x - r.x - 400) / 4, py = (t.y - r.y) / 4 - (1050 / 4 - s.baseline);
      if (px >= 0 && py >= 0 && px < s.w && py < s.h && s.ink[(py | 0) * s.w + (px | 0)] > 0.5) v = 0.15;
    }
    lum.data[y * W + x] = v;
  }
  const res = readSheet(lum, { pages: extraPages });
  assert(res.page === page, 'page ' + res.page);
  assert(res.samples.map(s => s.char).join('') === cells.join(''), res.samples.map(s => s.char).join(''));
}

test('template sheet: read a synthetic perspective photo', () => {
  const page = 1;
  const cells = PAGES[page].cells;
  // Photo corners for the template fiducials (a skewed, perspective view).
  const photo = [{ x: 140, y: 120 }, { x: 1300, y: 170 }, { x: 1250, y: 1640 }, { x: 90, y: 1580 }];
  const toTpl = homography(photo, FIDUCIALS);
  const W = 1400, H = 1750, lum = field(W, H);
  const writeIdx = [0, 5, 52]; // 'A', 'F', '0'
  const stamps = writeIdx.map(i => ({ i, s: strokesToSample(cells[i], [[{ x: 40, y: 0 }, { x: 300, y: 700 }, { x: 560, y: 0 }]], { penWidth: 70 }) }));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = toTpl(x, y);
    let v = 0.9 - 0.15 * (x / W); // uneven lighting
    for (const f of FIDUCIALS) if (Math.abs(t.x - f.x) < 300 && Math.abs(t.y - f.y) < 300) v = 0.08;
    for (let k = 0; k < 6; k++) {
      const bit = k < 5 ? (page >> k) & 1 : [0,1,2,3,4].reduce((a, j) => a ^ ((page >> j) & 1), 0);
      const cx = 6200 + (k - 2.5) * 450;
      if (bit && Math.abs(t.x - cx) < 150 && Math.abs(t.y + 500) < 150) v = 0.08;
    }
    for (const { i, s } of stamps) {
      const r = cellRect(i);
      const px = (t.x - r.x - 400) / 4, py = (t.y - r.y) / 4 - (1050 / 4 - s.baseline);
      if (px >= 0 && py >= 0 && px < s.w && py < s.h && s.ink[(py | 0) * s.w + (px | 0)] > 0.5) v = 0.15;
    }
    lum.data[y * W + x] = v;
  }
  const res = readSheet(lum);
  assert(res.page === page, 'page ' + res.page);
  assert(res.samples.length === 3, 'samples ' + res.samples.length + ' ' + res.samples.map(s => s.char));
  assert(res.samples.map(s => s.char).join('') === 'AF0', res.samples.map(s => s.char).join(''));
  const a = res.samples[0];
  // Ink bottom should sit near the baseline row.
  let bottom = 0; for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) if (a.ink[y * a.w + x] > 0.5) bottom = y;
  assert(Math.abs(bottom - a.baseline) < 12, `bottom ${bottom} vs baseline ${a.baseline}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
