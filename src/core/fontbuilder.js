// Project (samples + settings) -> font description for ttf.js, plus the
// glyph-level data the UI uses for inspection.
//
// The "living handwriting" model:
//   * every character gets N versions (real samples first, then synthesized
//     ones drawn from the natural-variation model);
//   * a GSUB 'calt' state machine picks each glyph's version from the version
//     of the glyph before it, with a per-character stride, so neighbouring
//     letters rarely repeat a shape and repeated letters never do;
//   * GPOS 'kern' is computed optically from the actual ink profiles;
//   * GSUB 'liga' swaps in real handwritten letter pairs (th, ll, ...).

import { METRICS, CHARSET, glyphNameFor } from './constants.js';
import { samplePolygons, transformPolys, buildOutline, drawVariation, profile } from './glyph.js';
import { hashString, median, rng } from './raster.js';
import { pickVersion, groupOf, CONTEXT_CODES, MAX_VERSIONS } from './versions.js';
import { train, generate, modelKey } from './learn.js';

export const DEFAULT_SETTINGS = {
  family: 'My Handwriting',
  designer: '',
  weight: 0,          // font units of stroke growth (+ bolder / - lighter)
  slant: 0,           // extra degrees of lean added on top of the writer's own
  spacing: 45,        // side bearing per side, font units
  wordSpace: 300,     // width of the space glyph
  variants: 6,        // versions per character (1 = static font)
  digitVariants: 12,  // digits repeat a lot, so they get more versions (when variants > 1)
  vary: {
    angle: 1.6,       // deg sd of per-glyph rotation
    baseline: 14,     // units sd of baseline bounce
    scale: 0.035,     // fractional sd of size
    spacing: 12,      // units sd of side-bearing change
    wobble: 7,        // units amplitude of smooth shape distortion
    weight: 4,        // units sd of pen-pressure change (stroke growth)
    width: 0.04,      // fractional sd of how wide each copy is drawn
  },
  varyRealSpacing: true, // real (non-synthetic) alternates still get spacing jitter
  learned: true,      // fill extra versions from the learned handwriting model
  creativity: 1,      // how far learned copies may stray (1 = your measured variation)
  kerning: true,
  kernStrength: 0.7,
  ligatures: true,
};

function notdef() {
  return {
    name: '.notdef', advance: 500, unicodes: [],
    contours: [
      [{ x: 50, y: 0, on: true }, { x: 50, y: 700, on: true }, { x: 450, y: 700, on: true }, { x: 450, y: 0, on: true }],
      [{ x: 100, y: 50, on: true }, { x: 400, y: 50, on: true }, { x: 400, y: 650, on: true }, { x: 100, y: 650, on: true }],
    ],
  };
}

function orderKey(ch) {
  const i = CHARSET.indexOf(ch);
  return i < 0 ? 10000 + (ch.codePointAt(0) || 0) : i;
}

/**
 * Plan the versions of every character.
 * Returns Map char -> [{ sample, variation|null, synthetic }]
 */
export function planVersions(samples, settings, model = null) {
  const byChar = new Map();
  for (const s of samples) {
    if (s.disabled) continue;
    if (!byChar.has(s.char)) byChar.set(s.char, []);
    byChar.get(s.char).push(s);
  }
  const N = Math.max(1, Math.min(MAX_VERSIONS, settings.variants | 0));
  const plan = new Map();
  for (const [ch, all] of byChar) {
    // Real handwriting always beats generated fill-ins for the same character.
    const realOnes = all.filter(s => s.source !== 'fill-in');
    const fillOnes = all.filter(s => s.source === 'fill-in');
    // A digit with only one or two real copies would otherwise be all warps of
    // the same drawing; let hand-drawn copies fill the remaining versions.
    const list = !realOnes.length ? all
      : /^[0-9]$/.test(ch) && realOnes.length < 3 ? realOnes.concat(fillOnes) : realOnes;
    const real = list.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.created - b.created);
    const isLig = [...ch].length > 1;
    // Digits repeat a lot (dates, prices, maths), so they can get more versions.
    const nd = Math.max(1, Math.min(MAX_VERSIONS, settings.digitVariants | 0 || N));
    const count = isLig ? 1 : /^[0-9]$/.test(ch) && N > 1 ? Math.max(N, nd) : N;
    const versions = [];
    for (let i = 0; i < count; i++) {
      const seed = hashString(ch) ^ Math.imul(i + 1, 0x9E3779B1);
      if (i < real.length) {
        let variation = null;
        if (i > 0 && settings.varyRealSpacing) {
          const d = drawVariation({ spacing: settings.vary.spacing }, seed);
          variation = { angle: 0, baseline: 0, scale: 1, spacing: d.spacing, wobble: 0, waves: null };
        }
        versions.push({ sample: real[i], variation, synthetic: false });
      } else {
        // Learned model: a new copy shaped by the writer's own learned variation;
        // only placement varies on top (the shape variation is already learned).
        const gen = model && !isLig ? generate(model, ch, i, { temperature: settings.creativity ?? 1, key: model.key }) : null;
        if (gen) {
          const v = drawVariation({ ...settings.vary, wobble: 0, angle: (settings.vary.angle || 0) * 0.4, scale: (settings.vary.scale || 0) * 0.4, width: 0 }, seed);
          versions.push({ sample: gen, variation: v, synthetic: 'learned' });
        } else {
          const src = real[i % real.length];
          versions.push({ sample: src, variation: drawVariation(settings.vary, seed), synthetic: true });
        }
      }
    }
    plan.set(ch, versions);
  }
  return plan;
}

/** Train (or reuse) the learned model for this library. */
let modelCache = null;
export function learnedModel(samples) {
  const key = modelKey(samples);
  if (modelCache && modelCache.key === key) return modelCache;
  const m = train(samples);
  m.key = key;
  modelCache = m;
  return m;
}

function outlineFor(version, settings) {
  // Lighter pressure thins strokes; cap it so thin-stroked letters never go pale or broken.
  const pressure = version.variation && version.variation.weight ? Math.max(-4, version.variation.weight) : 0;
  const polys = samplePolygons(version.sample, { weight: settings.weight + pressure });
  const v = version.variation;
  const t = transformPolys(polys, { slant: settings.slant, variation: v && v.waves ? v : v ? { ...v, waves: null } : null });
  const sj = v ? v.spacing : 0;
  return buildOutline(t, { lsb: Math.max(0, settings.spacing + sj / 2), rsb: Math.max(0, settings.spacing + sj / 2) });
}

/** Optical kerning from ink profiles. Returns Map "a|b" -> value. */
export function computeKerning(bases, settings) {
  const step = 20, lo = -400, hi = 1000;
  const prof = new Map();
  for (const [ch, g] of bases) {
    if (!g.contours.length) continue;
    const p = profile(g.contours, { lo, hi, step });
    // Dilate one band so near-misses in height still interact.
    const L = p.L.slice(), R = p.R.slice();
    for (let k = 0; k < p.n; k++) {
      for (const d of [-1, 1]) {
        const j = k + d; if (j < 0 || j >= p.n) continue;
        if (p.L[j] < L[k]) L[k] = p.L[j];
        if (p.R[j] > R[k]) R[k] = p.R[j];
      }
    }
    prof.set(ch, { L, R, n: p.n, adv: g.advance });
  }
  const gapOf = (a, b) => {
    const A = prof.get(a), B = prof.get(b);
    if (!A || !B) return null;
    let mn = Infinity, sum = 0, cnt = 0;
    for (let k = 0; k < A.n; k++) {
      if (!isFinite(A.R[k]) || !isFinite(B.L[k])) continue;
      const g = A.adv - A.R[k] + B.L[k];
      if (g < mn) mn = g; sum += g; cnt++;
    }
    if (cnt < 3) return null;
    return 0.7 * mn + 0.3 * (sum / cnt);
  };
  const refChars = [...'nohdbpuHOIl'].filter(c => prof.has(c));
  const refs = [];
  for (const a of refChars) for (const b of refChars) { const g = gapOf(a, b); if (g != null) refs.push(g); }
  const ref = refs.length ? median(refs) : settings.spacing * 2 + 20;
  const out = new Map();
  const chars = [...prof.keys()];
  for (const a of chars) for (const b of chars) {
    const g = gapOf(a, b);
    if (g == null) continue;
    let k = Math.round(settings.kernStrength * (ref - g));
    k = Math.max(-220, Math.min(60, k));
    if (Math.abs(k) >= 12) out.set(a + '|' + b, k);
  }
  return out;
}

/**
 * Build everything. Returns { font, glyphInfo, stats }.
 * glyphInfo: [{ gid, char, version, synthetic, sampleId, outline }]
 */
export function buildFont(samples, userSettings = {}, metricsOverride = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...userSettings, vary: { ...DEFAULT_SETTINGS.vary, ...(userSettings.vary || {}) } };
  const metrics = { ...METRICS, ...metricsOverride, italicAngle: 0 };
  const model = settings.learned && (settings.variants | 0) > 1 ? learnedModel(samples) : null;
  const plan = planVersions(samples, settings, model);

  const glyphs = [notdef(), { name: 'space', advance: settings.wordSpace, unicodes: [0x20, 0xA0], contours: [] }];
  const info = [];
  const singles = [...plan.keys()].filter(c => [...c].length === 1).sort((a, b) => orderKey(a) - orderKey(b));
  const ligs = [...plan.keys()].filter(c => [...c].length > 1).sort();

  const baseGid = new Map();
  const versionGids = new Map(); // char -> [gid per version]
  const bases = new Map();
  for (const ch of singles) {
    const v = plan.get(ch)[0];
    const o = outlineFor(v, settings);
    const gid = glyphs.length;
    glyphs.push({ name: glyphNameFor(ch), advance: o.advance, contours: o.contours, unicodes: [ch.codePointAt(0)] });
    info.push({ gid, char: ch, version: 0, synthetic: false, sampleId: v.sample.id, outline: o });
    baseGid.set(ch, gid); versionGids.set(ch, [gid]); bases.set(ch, o);
  }
  // Curly-quote fallbacks so typed text from word processors still uses the hand.
  const alias = { '’': "'", '‘': "'", '“': '"', '”': '"', '–': '-', '—': '-' };
  for (const [to, from] of Object.entries(alias)) {
    if (!baseGid.has(to) && baseGid.has(from)) glyphs[baseGid.get(from)].unicodes.push(to.codePointAt(0));
  }
  const ligGid = new Map();
  if (settings.ligatures) {
    for (const lg of ligs) {
      const parts = [...lg];
      if (!parts.every(p => baseGid.has(p))) continue;
      const v = plan.get(lg)[0];
      const o = outlineFor(v, settings);
      const gid = glyphs.length;
      glyphs.push({ name: parts.map(glyphNameFor).join('_'), advance: o.advance, contours: o.contours, unicodes: [] });
      info.push({ gid, char: lg, version: 0, synthetic: false, sampleId: v.sample.id, outline: o, ligature: true });
      ligGid.set(lg, gid);
    }
  }
  // N = most versions any character has (digits may have more than letters).
  const N = Math.max(1, ...singles.map(ch => plan.get(ch).length));
  for (let i = 1; i < N; i++) {
    for (const ch of singles) {
      const vs = plan.get(ch);
      if (i >= vs.length) continue;
      const o = outlineFor(vs[i], settings);
      const gid = glyphs.length;
      glyphs.push({ name: `${glyphNameFor(ch)}.v${i}`, advance: o.advance, contours: o.contours, unicodes: [] });
      info.push({ gid, char: ch, version: i, synthetic: vs[i].synthetic, sampleId: vs[i].sample.id, outline: o });
      versionGids.get(ch).push(gid);
    }
  }
  // Spaces get versions too: they pass the state between words (so repeated
  // words differ) and vary word spacing a little, even in apps like Word.
  const chainChars = singles.slice();
  if (N > 1) {
    const r = rng(hashString('space-versions'));
    const sd = Math.max(4, (settings.vary.spacing || 0) * 1.5);
    versionGids.set(' ', [1]);
    info.push({ gid: 1, char: ' ', version: 0, synthetic: false, sampleId: null, outline: { contours: [], advance: settings.wordSpace } });
    for (let i = 1; i < N; i++) {
      const adv = Math.max(Math.round(settings.wordSpace * 0.6), Math.round(settings.wordSpace + ((r() + r() + r() - 1.5) * 2) * sd));
      const gid = glyphs.length;
      glyphs.push({ name: `space.v${i}`, advance: adv, contours: [], unicodes: [] });
      info.push({ gid, char: ' ', version: i, synthetic: true, sampleId: null, outline: { contours: [], advance: adv } });
      versionGids.get(' ').push(gid);
    }
    baseGid.set(' ', 1);
    chainChars.push(' ');
  }
  // Zero-width context glyphs, one per state, on private-use codepoints. Apps
  // that draw text in pieces (like Inkforge's Write tab) put one in front of a
  // piece to continue the state exactly where the full text would be.
  const contextGid = [];
  if (N > 1) {
    for (let j = 0; j < N; j++) {
      contextGid.push(glyphs.length);
      glyphs.push({ name: `ctx${j}`, advance: 0, contours: [], unicodes: [CONTEXT_CODES[j]] });
    }
  }

  // ---- GSUB
  const gsub = { lookups: [], features: [] };
  if (ligGid.size) {
    const lk = { type: 4, subtables: [{ ligs: [...ligGid].map(([s, g]) => { const p = [...s].map(c => baseGid.get(c)); return { first: p[0], rest: p.slice(1), glyph: g }; }) }] };
    gsub.lookups.push(lk);
    gsub.features.push({ tag: 'liga', lookups: [gsub.lookups.length - 1] });
  }
  if (N > 1) {
    const chainIndex = gsub.lookups.length;
    gsub.lookups.push(null); // placeholder; single lookups follow it
    const singleIndex = new Map(); // m -> lookup index
    for (let m = 1; m < N; m++) {
      const map = new Map();
      for (const ch of chainChars) { const vg = versionGids.get(ch); if (vg.length > m) map.set(vg[0], vg[m]); }
      if (map.size) { singleIndex.set(m, gsub.lookups.length); gsub.lookups.push({ type: 1, subtables: [{ map }] }); }
    }
    // Compile the shared formula (core/versions.js) into class-based rules:
    //   backtrack class = the previous glyph's state (its version index; context
    //   glyph j = state j; anything else = 0); input class = characters in the
    //   same group with the same version count. Rule (class, j) -> version
    //   pickVersion(group, j, n).
    const backtrackClasses = new Map();
    for (const ch of chainChars) versionGids.get(ch).forEach((g, i) => { if (i > 0) backtrackClasses.set(g, i); });
    contextGid.forEach((g, j) => { if (j > 0) backtrackClasses.set(g, j); });
    const inputClasses = new Map(), groups = new Map(), coverageG = [];
    for (const ch of chainChars) {
      const n = versionGids.get(ch).length;
      if (n < 2) continue;
      const key = n + ':' + groupOf(ch);
      if (!groups.has(key)) groups.set(key, { cls: groups.size + 1, n, rep: ch });
      inputClasses.set(baseGid.get(ch), groups.get(key).cls);
      coverageG.push(baseGid.get(ch));
    }
    const rules = [];
    for (const { cls, n, rep } of groups.values()) {
      for (let j = 0; j < N; j++) {
        const m = pickVersion(rep, j, n); // depends only on (group, j, n)
        if (m && singleIndex.has(m)) rules.push({ input: cls, backtrack: [j], lookup: singleIndex.get(m) });
      }
    }
    if (rules.length) {
      // (Backtrack class 0 still needs a previous glyph to exist, so the first
      // glyph of a run keeps its main version, as before.)
      gsub.lookups[chainIndex] = { type: 6, subtables: [{ format: 2, coverage: coverageG, backtrackClasses, inputClasses, inputClassCount: groups.size + 1, rules }] };
      gsub.features.push({ tag: 'calt', lookups: [chainIndex] });
    } else {
      gsub.lookups.splice(chainIndex); // nothing to cycle
    }
  }

  // ---- GPOS kerning
  let gpos = null, kernPairs = 0;
  if (settings.kerning && bases.size > 1) {
    const kern = computeKerning(bases, settings);
    if (kern.size) {
      const chars = [...new Set([...kern.keys()].flatMap(k => k.split('|')))].sort((a, b) => orderKey(a) - orderKey(b));
      const cls = new Map(chars.map((c, i) => [c, i + 1]));
      const cd = new Map();
      for (const c of chars) for (const g of versionGids.get(c) || []) cd.set(g, cls.get(c));
      const n = chars.length + 1;
      const values = new Int16Array(n * n);
      for (const [k, v] of kern) { const [a, b] = k.split('|'); values[cls.get(a) * n + cls.get(b)] = v; }
      gpos = { lookups: [{ type: 2, subtables: [{ classDef1: cd, classDef2: cd, class1Count: n, class2Count: n, values }] }], features: [{ tag: 'kern', lookups: [0] }] };
      kernPairs = kern.size;
    }
  }

  const font = {
    family: settings.family, style: 'Regular', designer: settings.designer,
    metrics, glyphs, gsub: gsub.lookups.length ? gsub : null, gpos,
    maxContextHint: Math.max(2, ...[...ligGid.keys()].map(s => [...s].length)),
  };
  return {
    font, glyphInfo: info, settings,
    stats: {
      characters: singles.length, ligatures: ligGid.size, glyphs: glyphs.length,
      synthetic: info.filter(g => g.synthetic).length, kernPairs,
      missing: [...CHARSET].filter(c => !baseGid.has(c)),
    },
  };
}
