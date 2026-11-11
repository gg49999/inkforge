// Heavy lifting off the UI thread: sheet reading, page analysis, font builds.
import { luminance, resize, inkFlatField } from '../core/raster.js';
import { readSheet } from '../core/template.js';
import { findPaper } from '../core/page.js';
import { analyzeInk, candidateToSample } from '../core/analyze.js';
import { buildFont, learnedModel } from '../core/fontbuilder.js';
import { generate as learnGenerate, morph as learnMorph, modesFor } from '../core/learn.js';
import { writeTTF } from '../core/ttf.js';
import { clearTraceCache } from '../core/glyph.js';

const samples = new Map();
let lastAnalysis = null;

const ops = {
  setSamples(list) { samples.clear(); for (const s of list) samples.set(s.id, s); clearTraceCache(); return samples.size; },
  addSamples(list) { for (const s of list) samples.set(s.id, s); return samples.size; },
  removeSamples(ids) { for (const id of ids) samples.delete(id); return samples.size; },
  patchSample({ id, patch }) { const s = samples.get(id); if (s) Object.assign(s, patch); return !!s; },

  readSheet({ rgba, w, h, forcePage, pages }) {
    const lum = luminance(rgba, w, h);
    return readSheet(lum, { forcePage, pages: pages || [] });
  },

  analyze({ rgba, w, h, transcription }) {
    const paper = findPaper(rgba, w, h);
    const lum = luminance(rgba, w, h);
    const ink = inkFlatField(lum);
    for (let i = 0; i < ink.data.length; i++) ink.data[i] *= paper.field.data[i];
    const r = analyzeInk(ink, { transcription });
    lastAnalysis = r;
    const { inkField, labels, lineReports, ...report } = r;
    report.boxes = lineReports.map(l => l.boxes.map(b => ({ x0: b.rx0, x1: b.rx1, y0: b.y0, y1: b.y1 })));
    report.candidates = r.candidates.map(c => ({ ...c, crop: { w: c.crop.w, h: c.crop.h, data: c.crop.data } }));
    return report;
  },

  candidatesToSamples(labeled) {
    if (!lastAnalysis) throw new Error('Analyze a page first.');
    return labeled.map(({ index, char }) => {
      const c = lastAnalysis.candidates[index];
      return candidateToSample(c, char, { resizeFn: resize });
    });
  },

  /** Learned model overview (trains once per library, then cached). */
  learnReport() {
    const m = learnedModel([...samples.values()]);
    const chars = {};
    for (const [ch, e] of m.chars) {
      const tot = e.vars.reduce((a, b) => a + b, 0) || 1;
      chars[ch] = { trained: e.trained, modes: e.modes.length, explained: e.explained, share: e.vars.map(v => v / tot) };
    }
    return { stats: m.stats, globalModes: m.global.modes.length, chars };
  },

  /** For one character: generated copies and morph strips of its top modes. */
  learnChar({ ch, start = 0, count = 30, temperature = 1, modes = 3 }) {
    const m = learnedModel([...samples.values()]);
    const strip = s => s && { w: s.w, h: s.h, ink: s.ink, baseline: s.baseline };
    const gen = [];
    for (let i = start; i < start + count; i++) gen.push(strip(learnGenerate(m, ch, i + 1000, { temperature, key: m.key + ':ui' })));
    const own = modesFor(m, ch);
    const tot = own.vars.reduce((a, b) => a + b, 0) || 1;
    const morphs = [];
    for (let k = 0; k < Math.min(modes, own.modes.length); k++) {
      morphs.push({ share: own.vars[k] / tot, frames: learnMorph(m, ch, k, 5).map(f => ({ t: f.t, s: strip(f.sample) })) });
    }
    return { gen: gen.filter(Boolean), morphs, own: own.own };
  },

  build({ settings, metrics }) {
    const res = buildFont([...samples.values()], settings, metrics);
    const bytes = writeTTF(res.font);
    return {
      bytes,
      stats: res.stats,
      glyphs: res.glyphInfo.map(g => ({ gid: g.gid, char: g.char, version: g.version, synthetic: g.synthetic, ligature: !!g.ligature, sampleId: g.sampleId, advance: g.outline.advance, contours: g.outline.contours })),
    };
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await ops[op](args);
    const transfer = result && result.bytes ? [result.bytes.buffer] : [];
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};
