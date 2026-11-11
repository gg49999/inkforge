import { h, sampleThumb, forgetThumb, drawGlyph, download, loadImage, toast } from './render.js';
import { store, exportProject, importProject } from './store.js';
import { DrawPad } from './drawpad.js';
import { viewWrite } from './write.js';
import { viewModel } from './model.js';
import { CHARSET, LOWER, UPPER, DIGITS, DEFAULT_LIGATURES } from '../core/constants.js';
import { PAGES, templateSVG, gapSheets, wantedCount } from '../core/template.js';
import { DEFAULT_SETTINGS } from '../core/fontbuilder.js';
import { demoLibrary } from '../core/writers.js';
import { rng, hashString } from '../core/raster.js';

// ------------------------------------------------------------------ state ---
const state = {
  samples: [],
  settings: structuredClone(DEFAULT_SETTINGS),
  profile: null,      // last analysis summary (persisted)
  analysis: null,     // last full analysis (session only)
  analysisImage: null,
  build: null,
  libFilter: null,
  padChar: 'a',
};

// ----------------------------------------------------------------- worker ---
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const p = pending.get(e.data.id);
  if (!p) return;
  pending.delete(e.data.id);
  e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
};
function call(op, args, transfer = []) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args }, transfer);
  });
}

async function busy(msg, fn) {
  const el = document.getElementById('busy');
  document.getElementById('busyMsg').textContent = msg;
  el.hidden = false;
  try { return await fn(); } finally { el.hidden = true; }
}

// ---------------------------------------------------------------- samples ---
async function addSamples(list, { quiet = false } = {}) {
  if (!list.length) return;
  await store.putSamples(list);
  state.samples.push(...list);
  await call('addSamples', list);
  markDirty();
  if (!quiet) toast(`Added ${list.length} glyph sample${list.length === 1 ? '' : 's'} to the library`, 'good');
  updateSide();
}

async function removeSamples(ids) {
  await store.deleteSamples(ids);
  const set = new Set(ids);
  state.samples = state.samples.filter(s => !set.has(s.id));
  ids.forEach(forgetThumb);
  await call('removeSamples', ids);
  markDirty();
  updateSide();
}

async function patchSample(s, patch) {
  Object.assign(s, patch);
  await store.putSamples([s]);
  await call('patchSample', { id: s.id, patch });
  markDirty();
}

function countsByChar() {
  const m = new Map();
  for (const s of state.samples) if (!s.disabled) m.set(s.char, (m.get(s.char) || 0) + 1);
  return m;
}

let dirty = true;
function markDirty() { dirty = true; scheduleSync(); }

// ------------------------------------------------------------ disk sync ---
// The server keeps the project on disk (%LOCALAPPDATA%\Inkforge) so the
// library follows you to any browser and into the desktop app.
let syncTimer = null, syncOk = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(pushProject, 1500);
}
async function pushProject() {
  try {
    const savedAt = Date.now();
    const body = exportProject(state.samples, { settings: state.settings, profile: state.profile, gapSheets: state.gapSheets, savedAt });
    const r = await fetch('/api/project', { method: 'PUT', headers: { 'content-type': 'application/json' }, body });
    syncOk = r.ok;
    if (r.ok) await _setMeta('savedAt', savedAt);
  } catch { syncOk = false; }
  updateSide();
}
async function pullProject() {
  try {
    const r = await fetch('/api/project', { cache: 'no-store' });
    if (!r.ok) return null;
    return importProject(await r.text());
  } catch { return null; }
}

async function saveSettings() { await store.setMeta('settings', state.settings); markDirty(); }
const _setMeta = store.setMeta;
store.setMeta = async (k, v) => { const r = await _setMeta(k, v); if (k === 'profile' || k === 'gapSheets') scheduleSync(); return r; };

function updateSide() {
  const counts = countsByChar();
  const have = [...CHARSET].filter(c => counts.has(c)).length;
  document.getElementById('sideStats').innerHTML =
    `<b>${state.samples.length}</b> samples<br><b>${have}</b> / ${CHARSET.length} characters` +
    (state.profile ? `<br>style profile: <b>${state.profile.style}</b>` : '') +
    (syncOk === true ? '<br>saved to disk' : syncOk === false ? '<br><span style="color:var(--accent-2)">not saved to disk</span>' : '');
}

// ----------------------------------------------------------------- router ---
const views = { capture: viewCapture, analyze: viewAnalyze, library: viewLibrary, font: viewFont,
  write: (main) => viewWrite(main, { state, rebuild: async () => (dirty || !state.build ? rebuild() : state.build), busy }),
  model: (main) => viewModel(main, { state, call, busy, saveSettings, markDirty }) };
let cleanup = null;
function route() {
  const name = (location.hash.slice(1) || 'capture').split('?')[0];
  const fn = views[name] || viewCapture;
  for (const a of document.querySelectorAll('.side a')) a.classList.toggle('on', a.dataset.view === name);
  if (cleanup) { cleanup(); cleanup = null; }
  const main = document.getElementById('view');
  main.replaceChildren();
  cleanup = fn(main) || null;
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- capture ---
function viewCapture(main) {
  main.append(
    h('h1', {}, 'Capture your handwriting'),
    h('p', { class: 'lede' }, 'Three ways in, and you can mix them freely. Every sample, whatever the source, is normalized to the same baseline and scale, so a letter from a phone photo and one from a pen tablet sit together in one font.'),
  );

  // Sheets
  const sheets = h('div', { class: 'grid3' }, PAGES.map((p, i) => h('div', { class: 'sheet-card' },
    h('div', { class: 'thumb', html: templateSVG(i) }),
    h('b', {}, `Sheet ${i + 1}`),
    h('small', {}, `${p.title} · ${p.cells.length} boxes`),
    h('div', { class: 'row' },
      h('a', { class: 'btn primary', href: `print.html?sheet=${i}`, target: '_blank' }, 'Print'),
    ),
  )));
  main.append(h('div', { class: 'card' },
    h('h2', {}, 'A · Print sheets, write, photograph'),
    h('p', { class: 'muted' }, 'Sheet 1 asks for every lowercase letter three times (real variety beats synthetic variety) plus common letter pairs that become ligatures. Use a dark pen; pencil works if it is dark. The pale guides disappear automatically.'),
    sheets,
  ));

  // Gap-filler sheets: built from what the library is missing or thin on.
  const gapHost = h('div');
  const renderGaps = () => {
    const counts = countsByChar();
    const missing = [...CHARSET].filter(c => !counts.get(c));
    const thin = [...CHARSET].filter(c => counts.get(c) && counts.get(c) < wantedCount(c));
    const sheets = state.gapSheets || [];
    gapHost.replaceChildren(
      h('p', { class: 'muted' }, state.samples.length
        ? `Your library is missing ${missing.length} characters and is thin on ${thin.length} more. A gap-filler sheet asks only for those, in priority order: missing before thin, lowercase and digits before capitals before symbols.`
        : 'Once you have some samples, this builds a sheet of only the characters you still need.'),
      missing.length ? h('p', {}, h('small', { class: 'muted' }, 'Missing: '), h('span', { style: { fontFamily: 'Georgia, serif', letterSpacing: '3px' } }, missing.join(' '))) : null,
      h('div', { class: 'row', style: { margin: '10px 0' } },
        h('button', { class: 'primary', disabled: !(missing.length + thin.length), onclick: async () => {
          state.gapSheets = gapSheets(counts, CHARSET);
          await store.setMeta('gapSheets', state.gapSheets);
          renderGaps();
          toast(`Made ${state.gapSheets.length} gap-filler sheet${state.gapSheets.length === 1 ? '' : 's'}`, 'good');
        } }, sheets.length ? 'Rebuild from current library' : 'Make gap-filler sheet')),
      sheets.length ? h('div', { class: 'grid3' }, sheets.map(p => h('div', { class: 'sheet-card' },
        h('div', { class: 'thumb', html: templateSVG(p.index, p) }),
        h('b', {}, p.title), h('small', {}, `${p.cells.length} boxes`),
        h('div', { class: 'row' }, h('a', { class: 'btn primary', target: '_blank',
          // Self-contained link: the sheet travels in the URL, so it prints from any browser.
          href: `print.html?gap=${p.index}&title=${encodeURIComponent(p.title)}&cells=${encodeURIComponent(JSON.stringify(p.cells))}` }, 'Print'))))) : null,
    );
  };
  renderGaps();
  main.append(h('div', { class: 'card' }, h('h2', {}, 'Fill the gaps'), gapHost));

  // Upload sheets
  const result = h('div', { class: 'stack' });
  const pageSel = h('select', { style: { width: 'auto' } },
    h('option', { value: '' }, 'Detect sheet automatically'),
    PAGES.map((p, i) => h('option', { value: i }, `Sheet ${i + 1}: ${p.title}`)),
    (state.gapSheets || []).map(p => h('option', { value: p.index }, p.title)));
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const drop = h('div', { class: 'drop', onclick: () => input.click() },
    h('b', {}, 'Drop photos or scans of filled sheets'), h('br'), 'or click to choose. Flat, evenly lit, all four black corner squares visible.');
  const handle = async (files) => {
    for (const f of files) {
      try {
        const res = await busy(`Reading ${f.name}…`, async () => {
          const img = await loadImage(f, 3600);
          const forcePage = pageSel.value === '' ? null : Number(pageSel.value);
          return call('readSheet', { rgba: img.rgba, w: img.w, h: img.h, forcePage, pages: state.gapSheets || [] }, [img.rgba.buffer]);
        });
        await addSamples(res.samples, { quiet: true });
        const sheetName = PAGES[res.page] ? `Sheet ${res.page + 1}` : ((state.gapSheets || []).find(p => p.index === res.page)?.title || `Sheet ${res.page + 1}`);
        result.prepend(h('div', { class: 'card', style: { margin: 0 } },
          h('div', { class: 'row spread' },
            h('b', {}, `${f.name} → ${sheetName}`),
            h('span', { class: 'tag good' }, `${res.samples.length} glyphs, ${res.skipped.length} empty boxes`)),
          h('div', { class: 'row', style: { marginTop: '8px', gap: '4px' } },
            res.samples.slice(0, 60).map(s => h('img', { src: sampleThumb(s), title: s.char, style: { height: '34px' } }))),
        ));
        toast(`${sheetName}: ${res.samples.length} glyphs added`, 'good');
      } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); }
    }
  };
  input.onchange = () => handle([...input.files]);
  dragDrop(drop, handle);
  main.append(h('div', { class: 'card' }, h('h2', {}, 'B · Upload filled sheets'),
    h('div', { class: 'row', style: { marginBottom: '10px' } }, pageSel), drop, input, result));

  // Draw pad
  const canvas = h('canvas', { class: 'pad' });
  const charInput = h('input', { type: 'text', value: state.padChar, maxlength: 4, style: { width: '90px', fontSize: '20px', textAlign: 'center' } });
  const pen = h('input', { type: 'range', min: 25, max: 120, value: 60 });
  const queue = h('div', { class: 'queue' });
  const pad = new DrawPad(canvas);
  pad.char = state.padChar;
  const want = c => (c.length > 1 ? 1 : wantedCount(c));
  // Missing characters first, then thin ones, then everything else.
  const base = [...LOWER, ...DIGITS, ...UPPER, ...CHARSET.slice(62), ...DEFAULT_LIGATURES];
  const startCounts = countsByChar();
  const order = [
    ...base.filter(c => !startCounts.get(c)),
    ...base.filter(c => startCounts.get(c) && startCounts.get(c) < want(c)),
    ...base.filter(c => (startCounts.get(c) || 0) >= want(c)),
  ];
  if (!state.padTouched) { state.padChar = order[0]; pad.char = order[0]; charInput.value = order[0]; }
  const setChar = (c) => { state.padTouched = true; state.padChar = c; pad.char = c; charInput.value = c; pad.redraw(); renderQueue(); };
  const nextChar = () => {
    const counts = countsByChar();
    const i = order.indexOf(state.padChar);
    for (let k = 1; k <= order.length; k++) {
      const c = order[(i + k) % order.length];
      if ((counts.get(c) || 0) < want(c)) return setChar(c);
    }
    setChar(order[(i + 1) % order.length]);
  };
  const renderQueue = () => {
    const counts = countsByChar();
    queue.replaceChildren(...order.map(c => {
      const n = counts.get(c) || 0;
      return h('button', { class: `chip ${c === state.padChar ? 'on' : ''} ${n >= want(c) ? 'done' : ''}`, onclick: () => setChar(c), title: `${n} sample(s)` }, c, n ? h('span', { class: 'n' }, n) : null);
    }));
  };
  const save = async () => {
    const s = pad.toSample();
    if (!s) return toast('Write something first');
    s.char = charInput.value || state.padChar;
    await addSamples([s], { quiet: true });
    pad.clear();
    nextChar();
  };
  charInput.oninput = () => { if (charInput.value) { state.padChar = charInput.value; pad.char = charInput.value; pad.redraw(); renderQueue(); } };
  pen.oninput = () => { pad.penWidth = Number(pen.value); };
  const onKey = (e) => {
    if (e.target === charInput) { if (e.key === 'Enter') save(); return; }
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if ((e.key === 'z' && (e.ctrlKey || e.metaKey)) || e.key === 'Backspace') { e.preventDefault(); pad.undo(); }
    else if (e.key === 'Escape') pad.clear();
  };
  document.addEventListener('keydown', onKey);
  renderQueue();
  main.append(h('div', { class: 'card' },
    h('h2', {}, 'C · Write directly (pen, touch or mouse)'),
    h('p', { class: 'muted' }, 'Best with a stylus: pressure becomes stroke width. Enter saves and jumps to the next character that still needs samples. Ctrl+Z undoes a stroke, Esc clears.'),
    h('div', { class: 'pad-wrap' },
      canvas,
      h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('label', { class: 'field' }, 'Character', charInput),
          h('label', { class: 'field', style: { flex: 1 } }, 'Pen width', pen)),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: save }, 'Save & next ↵'),
          h('button', { onclick: () => pad.undo() }, 'Undo'),
          h('button', { class: 'ghost', onclick: () => pad.clear() }, 'Clear'),
          h('button', { class: 'ghost', onclick: nextChar }, 'Skip')),
        h('small', { class: 'muted' }, 'Missing characters come first. Lowercase and digits want 3 versions, capitals 2, symbols 1 (green = enough).'),
        queue,
      )),
  ));
  setTimeout(() => pad.redraw(), 0);
  return () => document.removeEventListener('keydown', onKey);
}

function dragDrop(el, handle) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); handle([...e.dataTransfer.files].filter(f => f.type.startsWith('image/'))); });
}

// ---------------------------------------------------------------- analyze ---
function viewAnalyze(main) {
  main.append(
    h('h1', {}, 'Analyze a handwriting sample'),
    h('p', { class: 'lede' }, 'Give it any page of your normal writing: a note, a journal page, a shopping list. Inkforge measures how you actually write, including how much your slant, baseline, size and spacing wander, and can tune the font to match. If the writing is printed rather than joined-up, it also cuts out individual letters you can label and add to the library.'),
  );
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  const text = h('textarea', { placeholder: 'Optional: type exactly what the page says, one line per written line. With it, letters get labeled automatically.' });
  const drop = h('div', { class: 'drop', onclick: () => input.click() }, h('b', {}, 'Drop a photo of handwriting'), h('br'), 'or click to choose');
  const out = h('div');
  let file = null;
  const run = async () => {
    if (!file) return toast('Choose an image first');
    try {
      const { report, img } = await busy('Reading your handwriting…', async () => {
        const img = await loadImage(file, 2000);
        const rgba = img.rgba.slice();
        const report = await call('analyze', { rgba, w: img.w, h: img.h, transcription: text.value }, [rgba.buffer]);
        return { report, img };
      });
      state.analysis = report; state.analysisImage = img.canvas; state.analysisSeq = (state.analysisSeq || 0) + 1;
      state.profile = summarize(report);
      await store.setMeta('profile', state.profile);
      updateSide();
      renderAnalysis(out);
    } catch (e) { toast(e.message, 'error'); }
  };
  const pick = (f) => { file = f; drop.replaceChildren(h('b', {}, f.name), h('br'), 'ready: press Analyze'); };
  input.onchange = () => input.files[0] && pick(input.files[0]);
  dragDrop(drop, fs => fs[0] && pick(fs[0]));
  main.append(h('div', { class: 'card' }, h('div', { class: 'grid2' }, drop, h('div', { class: 'stack' }, text,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: run }, 'Analyze'))))), input, out);
  if (state.analysis) renderAnalysis(out);
  else if (state.profile) out.append(h('div', { class: 'card' }, h('h2', {}, 'Saved style profile'), metricCards(state.profile), applyButton()));
}

function summarize(r) {
  const { candidates, boxes, lines, image, ...rest } = r;
  return { ...rest, lineCount: lines.length, at: Date.now() };
}

function metricCards(p) {
  const pct = v => `${Math.round(v * 100)}%`;
  const xh = p.xHeight || 1;
  const card = (k, v, d, bar) => h('div', { class: 'metric' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), h('div', { class: 'd' }, d),
    bar != null ? h('div', { class: 'bar' }, h('i', { style: { width: `${Math.max(3, Math.min(100, bar * 100))}%` } })) : null);
  const lean = p.slant > 2 ? 'leans right' : p.slant < -2 ? 'leans left' : 'upright';
  return h('div', { class: 'metrics' },
    card('Style', p.style, `letters average ${p.connectedness.toFixed(1)}× the x-height in width (${p.style === 'print' ? 'separate letters' : 'joined strokes'})`, Math.min(1, p.connectedness / 3)),
    card('Slant', `${p.slant > 0 ? '+' : ''}${p.slant.toFixed(0)}°`, `${lean}; varies ±${p.slantSpread.toFixed(1)}° letter to letter`, Math.abs(p.slant) / 40),
    card('x-height', `${p.xHeight.toFixed(0)} px`, `ascenders ${p.ascenderRatio.toFixed(2)}×, descenders ${p.descenderRatio.toFixed(2)}× the x-height`),
    card('Stroke', `${(p.strokeWidth / xh * 100).toFixed(0)}% of x-height`, `pen pressure varies ${pct(p.pressureVariation)}`, p.strokeWidth / xh * 3),
    card('Baseline', `±${(p.baselineBounce / xh * 100).toFixed(0)}%`, `bounce of x-height; lines drift ${p.baselineDrift.toFixed(1)}°`, p.baselineBounce / xh * 4),
    card('Size consistency', pct(1 - p.sizeVariation), `letter height varies ${pct(p.sizeVariation)}`, 1 - p.sizeVariation),
    card('Letter spacing', `${(p.letterGap / xh * 100).toFixed(0)}%`, `of x-height, ±${(p.letterGapSpread / xh * 100).toFixed(0)}%`, p.letterGap / xh),
    card('Word spacing', p.wordGap ? `${(p.wordGap / xh * 100).toFixed(0)}%` : '—', p.wordGap ? 'of x-height' : 'no clear word gaps found'),
    card('Page', `${p.lineCount} lines`, `paper skew corrected by ${p.skew.toFixed(1)}°`),
  );
}

function applyButton() {
  return h('div', { class: 'row', style: { marginTop: '14px' } },
    h('button', { class: 'primary', onclick: async () => {
      const s = state.profile.suggested;
      Object.assign(state.settings, { spacing: s.spacing, wordSpace: s.wordSpace, vary: { ...s.vary } });
      await saveSettings();
      toast('Font variation and spacing now follow your measured handwriting', 'good');
    } }, 'Apply measured style to the font'),
    h('small', { class: 'muted' }, 'Sets letter and word spacing plus the natural-variation model (angle, baseline bounce, size, spacing, wobble) from this page.'));
}

function renderAnalysis(out) {
  const r = state.analysis, img = state.analysisImage;
  out.replaceChildren();
  // Overlay
  const cv = h('canvas', { class: 'overlay' });
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.translate(img.width / 2, img.height / 2); ctx.rotate(-r.skew * Math.PI / 180); ctx.translate(-img.width / 2, -img.height / 2);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
  ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(0, 0, cv.width, cv.height);
  const lw = Math.max(1, img.width / 900);
  r.lines.forEach((l, i) => {
    const X0 = 0, X1 = cv.width;
    ctx.fillStyle = 'rgba(59,91,219,.10)';
    ctx.beginPath();
    ctx.moveTo(X0, l.icpt + l.slope * X0 - l.xHeight); ctx.lineTo(X1, l.icpt + l.slope * X1 - l.xHeight);
    ctx.lineTo(X1, l.icpt + l.slope * X1); ctx.lineTo(X0, l.icpt + l.slope * X0); ctx.fill();
    ctx.strokeStyle = '#3b5bdb'; ctx.lineWidth = lw * 2;
    ctx.beginPath(); ctx.moveTo(X0, l.icpt + l.slope * X0); ctx.lineTo(X1, l.icpt + l.slope * X1); ctx.stroke();
    ctx.strokeStyle = 'rgba(194,85,58,.8)'; ctx.lineWidth = lw;
    for (const b of r.boxes[i]) ctx.strokeRect(b.x0 - 1, b.y0 - 1, b.x1 - b.x0 + 3, b.y1 - b.y0 + 3);
  });
  // Slant indicator
  const t = Math.tan(r.slant * Math.PI / 180), L = Math.min(cv.height / 4, 160), ox = cv.width - L * 0.8, oy = L * 1.2;
  ctx.strokeStyle = '#c2553a'; ctx.lineWidth = lw * 3;
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + t * L, oy - L); ctx.stroke();
  ctx.setLineDash([6, 6]); ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - L); ctx.stroke(); ctx.setLineDash([]);

  out.append(h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', {}, 'What Inkforge sees'), h('small', { class: 'muted' }, 'blue: baseline & x-height band · orange: letter boxes · corner: dominant slant')),
    cv));
  out.append(h('div', { class: 'card' }, h('h2', {}, 'Your handwriting, measured'), metricCards(state.profile), applyButton()));

  // Candidates
  const cands = r.candidates;
  const sure = cands.filter(c => c.confident).length;
  const grid = h('div', { class: 'cands' });
  const inputs = [];
  let lastLine = -1;
  cands.forEach((c, i) => {
    if (c.line !== lastLine) { grid.append(h('div', { class: 'cand-line' }, `Line ${c.line + 1}`)); lastLine = c.line; }
    const thumb = sampleThumb({ id: `cand-${state.analysisSeq}-${i}`, w: c.crop.w, h: c.crop.h, ink: c.crop.data });
    const inp = h('input', { type: 'text', value: c.confident ? c.label || '' : '', maxlength: 4, placeholder: c.label || '?', title: c.kind ? `${c.kind}, quality ${(c.quality * 100).toFixed(0)}%` : '' });
    inputs.push(inp);
    grid.append(h('div', { class: `cand ${c.confident ? 'sure' : ''}` }, h('img', { src: thumb }), inp));
  });
  const addBtn = h('button', { class: 'primary', onclick: async () => {
    const labeled = inputs.map((inp, index) => ({ index, char: inp.value.trim() })).filter(x => x.char);
    if (!labeled.length) return toast('Type the letter under each box you want to keep');
    const samples = await busy('Normalizing glyphs…', () => call('candidatesToSamples', labeled));
    await addSamples(samples);
  } }, 'Add labeled glyphs to library');
  out.append(h('div', { class: 'card' },
    h('h2', {}, `Letters found: ${cands.length}`),
    h('p', { class: 'muted' }, sure ? `${sure} were labeled from your transcription (green). Fix anything wrong, clear boxes you don't want, then add.` :
      'Type the character under each box you want to keep (leave blank to skip). Joined-up words come out as one box: label it with the whole word if you want it as a ligature, or skip it.'),
    grid, h('div', { class: 'row', style: { marginTop: '12px' } }, addBtn)));
}

// ---------------------------------------------------------------- library ---
function viewLibrary(main) {
  const counts = countsByChar();
  const chars = [...new Set([...CHARSET, ...state.samples.map(s => s.char)])];
  const cov = h('div', { class: 'coverage' }, chars.map(c => h('div', {
    class: `cov ${counts.has(c) ? 'have' : ''} ${state.libFilter === c ? 'sel' : ''}`, title: c,
    onclick: () => { state.libFilter = state.libFilter === c ? null : c; route(); },
  }, c.length > 2 ? c.slice(0, 2) + '…' : c, counts.get(c) ? h('span', { class: 'n' }, counts.get(c)) : null)));

  const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    try {
      const { samples, meta } = importProject(await fileIn.files[0].text());
      const known = new Set(state.samples.map(s => s.id));
      await addSamples(samples.filter(s => !known.has(s.id)));
      if (meta.settings) { state.settings = { ...state.settings, ...meta.settings }; await saveSettings(); }
      route();
    } catch (e) { toast(e.message, 'error'); }
  } });

  main.append(
    h('div', { class: 'row spread' }, h('h1', {}, 'Glyph library'),
      h('div', { class: 'row' },
        h('button', { onclick: () => download(`${slug(state.settings.family)}.inkforge.json`, exportProject(state.samples, { settings: state.settings, profile: state.profile }), 'application/json') }, 'Export project'),
        h('button', { onclick: () => fileIn.click() }, 'Import'), fileIn,
        h('button', { class: 'ghost', title: 'A synthetic handwriting (not a real person’s) with several copies of every character, to try Inkforge without writing anything', onclick: async () => {
          const stamp = Date.now().toString(36);
          const lib = demoLibrary(CHARSET, ch => rng(hashString('demo:' + ch))).map(s => ({ ...s, id: `${s.id}-${stamp}` }));
          await addSamples(lib); route();
        } }, 'Load demo writer'),
        h('button', { class: 'ghost danger', onclick: async () => {
          if (!state.samples.length || !confirm(`Delete all ${state.samples.length} samples? Export first if you want a backup.`)) return;
          await store.clearSamples(); state.samples = []; await call('setSamples', []); scheduleSync(); updateSide(); route();
        } }, 'Delete all'))),
    h('p', { class: 'lede' }, 'Everything you have captured. The ★ sample of each character is its main version; the others become alternates the font rotates through. Disabled samples are kept but left out of the font.'),
    h('div', { class: 'card' }, h('h3', {}, 'Coverage'), cov, h('small', { class: 'muted' }, 'Click a character to filter. Characters without samples fall back to another font when typed.')),
  );

  if (!state.samples.length) {
    main.append(h('div', { class: 'card empty' }, h('h2', {}, 'No samples yet'), h('p', {}, 'Capture some handwriting first, or click “Load demo writer” above to try everything with a synthetic hand.'), h('a', { class: 'btn primary', href: '#capture' }, 'Go to Capture')));
    return;
  }
  const groups = new Map();
  for (const s of state.samples) {
    if (state.libFilter && s.char !== state.libFilter) continue;
    if (!groups.has(s.char)) groups.set(s.char, []);
    groups.get(s.char).push(s);
  }
  const ordered = [...groups.keys()].sort((a, b) => (CHARSET.indexOf(a) + 1 || 999) - (CHARSET.indexOf(b) + 1 || 999) || a.localeCompare(b));
  const list = h('div', { class: 'card' });
  for (const ch of ordered) {
    const items = groups.get(ch).sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || a.created - b.created);
    list.append(h('div', { class: 'lib-group' }, h('div', { class: 'ch' }, ch),
      h('div', { class: 'lib-items' }, items.map((s, i) => {
        const el = h('div', { class: `sample ${s.favorite ? 'fav' : ''} ${s.disabled ? 'off' : ''}`, title: `${s.source || ''}` },
          h('span', { class: 'src' }, i === 0 && !s.disabled ? 'main' : ''),
          h('img', { src: sampleThumb(s) }),
          h('div', { class: 'tools' },
            h('button', { title: 'Make main version', onclick: async () => { for (const o of groups.get(ch)) if (o.favorite) await patchSample(o, { favorite: false }); await patchSample(s, { favorite: true }); route(); } }, '★'),
            h('button', { title: s.disabled ? 'Enable' : 'Disable', onclick: async () => { await patchSample(s, { disabled: !s.disabled }); route(); } }, s.disabled ? 'on' : 'off'),
            h('button', { title: 'Delete', class: 'danger', onclick: async () => { await removeSamples([s.id]); route(); } }, '✕')));
        return el;
      }))));
  }
  main.append(list);
}

const slug = s => (s || 'handwriting').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'handwriting';

// ------------------------------------------------------------------- font ---
let fontSeq = 0, activeFace = null;

async function rebuild() {
  const res = await call('build', { settings: state.settings });
  const name = `InkforgePreview${++fontSeq}`;
  const face = new FontFace(name, res.bytes);
  await face.load();
  document.fonts.add(face);
  if (activeFace) document.fonts.delete(activeFace);
  activeFace = face;
  state.build = { ...res, family: name };
  dirty = false;
  return state.build;
}

function viewFont(main) {
  if (!state.samples.length) {
    main.append(h('h1', {}, 'Font'), h('div', { class: 'card empty' }, h('h2', {}, 'Nothing to build yet'), h('p', {}, 'Add handwriting samples first, or load the demo writer from the Library.'), h('a', { class: 'btn primary', href: '#capture' }, 'Capture handwriting')));
    return;
  }
  const S = state.settings;
  let timer = null, alive = true;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => { saveSettings(); refresh(); }, 350); };

  const slider = (label, get, set, min, max, step, fmt, hint) => {
    const out = h('output', {}, fmt(get()));
    const inp = h('input', { type: 'range', min, max, step, value: get(), oninput: () => { set(Number(inp.value)); out.textContent = fmt(get()); schedule(); } });
    return h('label', { class: 'slider' }, h('span', {}, label), out, inp, hint ? h('span', { class: 'hint' }, hint) : null);
  };
  const check = (label, get, set) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: get(), onchange: e => { set(e.target.checked); schedule(); } }), label);
  const name = h('input', { type: 'text', value: S.family, oninput: () => { S.family = name.value; schedule(); } });

  const controls = h('div', { class: 'card controls' },
    h('label', { class: 'field' }, 'Font name', name),
    h('h3', {}, 'Shape'),
    slider('Weight', () => S.weight, v => S.weight = v, -30, 50, 1, v => `${v > 0 ? '+' : ''}${v}`, 'grows or thins every stroke'),
    slider('Extra slant', () => S.slant, v => S.slant = v, -15, 25, 0.5, v => `${v}°`, 'added on top of your own lean'),
    h('h3', {}, 'Spacing'),
    slider('Letter spacing', () => S.spacing, v => S.spacing = v, 0, 160, 1, v => `${v}`),
    slider('Word spacing', () => S.wordSpace, v => S.wordSpace = v, 120, 700, 5, v => `${v}`),
    check('Optical kerning', () => S.kerning, v => S.kerning = v),
    slider('Kerning strength', () => S.kernStrength, v => S.kernStrength = v, 0, 1, 0.05, v => v.toFixed(2)),
    h('h3', {}, 'Natural variation'),
    slider('Versions per number', () => S.digitVariants ?? 12, v => S.digitVariants = v, 1, 64, 1, v => `${v}`, 'digits repeat a lot, so they can get more versions than letters'),
    slider('Versions per letter', () => S.variants, v => S.variants = v, 1, 64, 1, v => v === 1 ? 'off' : `${v}`, 'up to 64: real samples first, then learned copies. More versions = more variety, a bigger font file and a slower first build'),
    slider('Angle wander', () => S.vary.angle, v => S.vary.angle = v, 0, 6, 0.1, v => `±${v.toFixed(1)}°`),
    slider('Baseline bounce', () => S.vary.baseline, v => S.vary.baseline = v, 0, 60, 1, v => `±${v}`),
    slider('Size wander', () => S.vary.scale, v => S.vary.scale = v, 0, 0.12, 0.005, v => `±${(v * 100).toFixed(1)}%`),
    slider('Spacing wander', () => S.vary.spacing, v => S.vary.spacing = v, 0, 60, 1, v => `±${v}`),
    slider('Shape wobble', () => S.vary.wobble, v => S.vary.wobble = v, 0, 20, 0.5, v => `${v}`),
    slider('Pen pressure wander', () => S.vary.weight ?? 4, v => S.vary.weight = v, 0, 12, 1, v => `±${v}`, 'stroke gets heavier or lighter per copy'),
    slider('Width wander', () => S.vary.width ?? 0.04, v => S.vary.width = v, 0, 0.12, 0.005, v => `±${(v * 100).toFixed(1)}%`),
    check('Spacing wander on real samples too', () => S.varyRealSpacing, v => S.varyRealSpacing = v),
    check('Use handwritten letter pairs (ligatures)', () => S.ligatures, v => S.ligatures = v),
    state.profile ? h('button', { class: 'small', style: { marginTop: '10px' }, onclick: () => {
      const s = state.profile.suggested; Object.assign(S, { spacing: s.spacing, wordSpace: s.wordSpace, vary: { ...s.vary } }); route(); saveSettings();
    } }, 'Reset to measured style') : null,
  );

  const stats = h('div', { class: 'stats' });
  const size = h('input', { type: 'range', min: 18, max: 110, value: 46 });
  const text = 'The quick brown fox jumps over the lazy dog.\nletter little hello committee 2026\nSphinx of black quartz, judge my vow!';
  const live = h('div', { class: 'preview', contenteditable: 'plaintext-only', spellcheck: 'false' }, text);
  const flat = h('div', { class: 'preview off' }, text);
  live.addEventListener('input', () => { flat.textContent = live.textContent; });
  size.oninput = () => { live.style.fontSize = flat.style.fontSize = size.value + 'px'; };
  const showPts = h('input', { type: 'checkbox' });
  const glyphGrid = h('div', { class: 'glyphs' });
  const dl = h('button', { class: 'primary', onclick: async () => {
    if (dirty || !state.build) await busy('Building font…', rebuild);
    download(`${slug(S.family)}.ttf`, state.build.bytes, 'font/ttf');
  } }, 'Download .ttf');

  const missing = h('div');
  main.append(
    h('div', { class: 'row spread' }, h('h1', {}, 'Your font'), h('div', { class: 'row' }, dl)),
    h('p', { class: 'lede' }, 'Live preview of the real font file. Type in the top box: repeated letters (look at "letter", "committee") take different shapes because the font rotates between versions as you type. The bottom box shows the same text with that switched off.'),
    h('div', { class: 'font-wrap' }, controls, h('div', {},
      h('div', { class: 'card' }, h('div', { class: 'row spread' }, stats, h('label', { class: 'row muted' }, 'Size', size)), missing),
      h('div', { class: 'card' }, h('div', { class: 'compare' },
        h('div', {}, h('div', { class: 'label' }, 'With natural variation'), live),
        h('div', {}, h('div', { class: 'label' }, 'Static (one shape per letter)'), flat))),
      h('div', { class: 'card' }, h('div', { class: 'row spread' }, h('h2', {}, 'Glyphs & versions'),
        h('label', { class: 'check' }, showPts, 'show outline points')),
        h('p', { class: 'muted', style: { fontSize: '13px' } }, 'Each box: the main glyph first, then its alternates. Faded ones are synthesized from your real samples.'),
        glyphGrid),
    )),
  );
  showPts.onchange = () => drawGlyphGrid();

  function drawGlyphGrid() {
    const b = state.build; if (!b) return;
    const byChar = new Map();
    for (const g of b.glyphs) { if (g.char === ' ') continue; if (!byChar.has(g.char)) byChar.set(g.char, []); byChar.get(g.char).push(g); }
    glyphGrid.replaceChildren();
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
    for (const [ch, gs] of byChar) {
      gs.sort((a, b) => a.version - b.version);
      const vs = h('div', { class: 'vs' });
      glyphGrid.append(h('div', { class: 'gcell' }, h('div', { class: 'name' }, h('span', {}, ch), h('span', {}, gs.length > 1 ? `${gs.length} versions` : (gs[0].ligature ? 'ligature' : ''))), vs));
      for (const g of gs) {
        const c = h('canvas', { class: g.synthetic ? 'syn' : '', title: g.synthetic ? 'synthesized variant' : 'from your handwriting' });
        if (g.ligature) c.style.flex = '3';
        vs.append(c);
        requestAnimationFrame(() => drawGlyph(c, g, { color: g.synthetic ? '#7a86a8' : ink, points: showPts.checked }));
      }
    }
  }

  async function refresh() {
    try {
      const b = await rebuild();
      if (!alive) return;
      for (const el of [live, flat]) el.style.fontFamily = `"${b.family}", cursive`;
      stats.replaceChildren(
        h('span', {}, h('b', {}, b.stats.characters), ' characters'),
        h('span', {}, h('b', {}, b.stats.glyphs), ' glyphs'),
        h('span', {}, h('b', {}, b.stats.synthetic), ' synthesized'),
        h('span', {}, h('b', {}, b.stats.ligatures), ' ligatures'),
        h('span', {}, h('b', {}, b.stats.kernPairs), ' kern pairs'),
        h('span', {}, h('b', {}, (b.bytes.length / 1024).toFixed(0)), ' KB'));
      const miss = b.stats.missing.filter(c => c.trim());
      missing.replaceChildren(miss.length ? h('small', { class: 'muted' }, `Missing ${miss.length}: `, h('span', { style: { fontFamily: 'Georgia, serif', letterSpacing: '2px' } }, miss.join(' '))) : h('small', { class: 'tag good' }, 'Full character set covered'));
      drawGlyphGrid();
    } catch (e) { toast('Build failed: ' + e.message, 'error'); console.error(e); }
  }
  refresh();
  return () => { alive = false; clearTimeout(timer); };
}

// ------------------------------------------------------------------- boot ---
// Heartbeat: lets the desktop app's server know a window is still open.
setInterval(() => { fetch('/api/ping', { cache: 'no-store' }).catch(() => {}); }, 20000);

(async function boot() {
  try {
    const [samples, settings, profile, gaps] = await Promise.all([store.allSamples(), store.getMeta('settings'), store.getMeta('profile'), store.getMeta('gapSheets')]);
    state.gapSheets = gaps || [];
    state.samples = samples || [];
    if (settings) state.settings = { ...state.settings, ...settings, vary: { ...state.settings.vary, ...(settings.vary || {}) } };
    state.profile = profile || null;
    // This browser has nothing yet (new browser, or the desktop app's first run):
    // restore the project saved on disk. If the disk has nothing, seed it from here.
    const disk = await pullProject();
    const localAt = (await store.getMeta('savedAt')) || 0;
    const diskNewer = disk && disk.samples.length && (disk.meta?.savedAt || 0) > localAt;
    if (disk && disk.samples.length && (!state.samples.length || diskNewer)) {
      // The project on disk is newer (changed in another browser / the desktop app): use it.
      if (state.samples.length) await store.clearSamples();
      await store.putSamples(disk.samples);
      state.samples = disk.samples;
      await _setMeta('savedAt', disk.meta?.savedAt || Date.now());
      const m = disk.meta || {};
      if (m.settings) { state.settings = { ...state.settings, ...m.settings, vary: { ...state.settings.vary, ...(m.settings.vary || {}) } }; await _setMeta('settings', state.settings); }
      if (m.profile) { state.profile = m.profile; await _setMeta('profile', m.profile); }
      if (m.gapSheets) { state.gapSheets = m.gapSheets; await _setMeta('gapSheets', m.gapSheets); }
      syncOk = true;
      toast(`Restored ${disk.samples.length} samples from your saved project`, 'good');
    } else if (state.samples.length && !disk) {
      scheduleSync();
    } else if (disk) syncOk = true;
    await call('setSamples', state.samples);
  } catch (e) { toast('Storage unavailable: ' + e.message, 'error'); }
  updateSide();
  route();
})();
