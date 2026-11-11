// "Write" — a small word processor that typesets in the handwriting font and
// shows off everything that makes it a hand rather than a typeface.
//
// How it works: the page you type into is a transparent contenteditable layer.
// Underneath it, every visual line is re-drawn in the font as its own element
// with its own tilt, drift and ink flow ("line wobble"), positioned from the
// editable layer's real line boxes — so editing, selection and the caret are
// native while the ink looks hand-placed.

import { h, drawGlyph, toast, download, addContour } from './render.js';
import { imagesToPDF } from '../core/pdf.js';
import { versionChain, contextChar } from '../core/versions.js';
import { rng, hashString } from '../core/raster.js';

const PAPERS = {
  plain: { label: 'Plain', bg: '#fdfcf8' },
  college: { label: 'College ruled', bg: '#fdfcf8', rule: '#a9c4ea', margin: '#e8a0a0' },
  legal: { label: 'Legal pad', bg: '#fbf3b9', rule: '#9fb7d6', margin: '#d98c8c' },
  graph: { label: 'Graph', bg: '#fdfcf8', grid: '#cfe0f2' },
};
const INKS = {
  blue: { label: 'Blue ballpoint', color: '#1d3a8a' },
  black: { label: 'Black gel', color: '#17171f' },
  red: { label: 'Red pen', color: '#b3262a' },
  pencil: { label: 'Pencil', color: '#55565c', pencil: true },
};
const VCOLORS = ['#94a3b8', '#e4572e', '#f3a712', '#29bf12', '#00a5cf', '#7b2cbf', '#ff66b3', '#3a86ff'];

const SAMPLE = `Inkforge Write

This page is typed, but it is set in my own handwriting. Every letter in this font has eight different versions, and the font picks a new one as you type, so double letters like "letter", "committee", "bookkeeper" and "aardvark" never repeat the same shape.

Line wobble is not in the font, it is how a hand moves across a page: each line tilts a little, the baseline wanders up and down, the left margin drifts, and lines tend to slope downhill as you get tired. Turn the sliders up to exaggerate it.

Numbers and symbols: 0123456789  $40.75  25% of 300 = 75  (x + y) / 2  #1 @ 9:35!

The quick brown fox jumps over the lazy dog. Sphinx of black quartz, judge my vow. Pack my box with five dozen liquor jugs.`;

const DEFAULTS = {
  size: 30, lineHeight: 1.65, paper: 'college', ink: 'blue', align: 'left', variation: true,
  tilt: 0.6, drift: 2.5, margin: 4, slope: 0.25, spacing: 1.5, flow: 0.12, seed: 7, xray: false,
  wBounce: 1.8, wTilt: 0.9, wGap: 1.2,   // per-word wobble (px, deg, px)
  // Page margins in inches (Letter page, 96 px per inch on screen).
  mTop: 0.6, mBottom: 0.8, mLeft: 1.15, mRight: 0.85, v: 2,
};

const DPI = 96, PAGE_W = 8.5 * DPI;
const MARGIN_PRESETS = {
  normal: { label: 'Normal (1″)', mTop: 1, mBottom: 1, mLeft: 1, mRight: 1 },
  narrow: { label: 'Narrow (0.5″)', mTop: 0.5, mBottom: 0.5, mLeft: 0.5, mRight: 0.5 },
  moderate: { label: 'Moderate', mTop: 1, mBottom: 1, mLeft: 0.75, mRight: 0.75 },
  wide: { label: 'Wide', mTop: 1, mBottom: 1, mLeft: 2, mRight: 2 },
  notebook: { label: 'Notebook', mTop: 0.6, mBottom: 0.8, mLeft: 1.15, mRight: 0.85 },
};
const presetOf = o => Object.keys(MARGIN_PRESETS).find(k => ['mTop', 'mBottom', 'mLeft', 'mRight'].every(m => Math.abs(MARGIN_PRESETS[k][m] - o[m]) < 0.01)) || 'custom';

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode */ } }

const gauss = r => (r() + r() + r() - 1.5) * 2;

export function viewWrite(main, ctx) {
  const { state, rebuild } = ctx;
  if (!state.samples.length) {
    main.append(h('h1', {}, 'Write'), h('div', { class: 'card empty' }, h('h2', {}, 'No handwriting yet'), h('p', {}, 'Capture some handwriting first, then come back to write with it.'), h('a', { class: 'btn primary', href: '#capture' }, 'Capture handwriting')));
    return;
  }
  const saved = load('inkforge.write.opts', {});
  // v1 pages started 1" down; move older saved layouts to the tighter top once.
  if (saved && !saved.v) { delete saved.mTop; delete saved.mBottom; }
  const opt = { ...DEFAULTS, ...saved, v: 2 };
  let family = null, versions = new Map(); // char -> version count
  let alive = true, raf = 0;

  // ---------------------------------------------------------------- DOM
  const ink = h('div', { class: 'w-ink', 'aria-hidden': 'true' });
  // Each typed line is its own block so it can carry its own size.
  const edit = h('div', { class: 'w-edit', contenteditable: 'true', spellcheck: 'true' });
  const paper = h('div', { class: 'w-paper' }, ink, edit);

  /** Document model: [{ t: text, s: size|null }] (null = default size). */
  function loadDoc() {
    const d = load('inkforge.write.doc2', null);
    if (Array.isArray(d) && d.length) return d;
    const old = load('inkforge.write.doc', SAMPLE);
    return String(old).split('\n').map(t => ({ t, s: null }));
  }
  function setDoc(doc) {
    edit.replaceChildren(...doc.map(p => {
      const div = h('div', {}, p.t || h('br'));
      if (p.s) div.style.fontSize = p.s + 'px';
      return div;
    }));
  }
  function getDoc() {
    normalize();
    return [...edit.children].map(div => ({ t: div.textContent, s: div.style.fontSize ? parseFloat(div.style.fontSize) : null }));
  }
  /** Keep the page as a flat list of <div> lines (browsers sometimes leave bare text or nested blocks). */
  function normalize() {
    let run = null;
    for (const n of [...edit.childNodes]) {
      if (n.nodeType === 1 && n.tagName === 'DIV') { run = null; continue; }
      if (!run) { run = document.createElement('div'); edit.insertBefore(run, n); }
      run.append(n);
      if (n.nodeType === 1 && n.tagName === 'BR') run = null; // a <br> ends a line
    }
    // Strip formatting the browser may have added inside a line (only per-line size is allowed).
    // ':scope > div' = the line blocks themselves, never the page.
    for (const el of edit.querySelectorAll(':scope > div *:not(br)')) el.replaceWith(...el.childNodes);
    // Nested blocks (e.g. from Enter inside odd markup) are flattened into sibling lines.
    for (const inner of edit.querySelectorAll(':scope > div div')) {
      blockOf(inner).after(inner);
    }
    for (const div of edit.children) { const s = div.style.fontSize; div.removeAttribute('style'); if (s) div.style.fontSize = s; }
    if (!edit.children.length) edit.append(h('div', {}, h('br')));
  }
  setDoc(loadDoc());

  // Plain-text paste, one line per pasted line; no bold/italic/etc.
  edit.addEventListener('paste', e => {
    e.preventDefault();
    const lines = (e.clipboardData.getData('text/plain') || '').replace(/\r/g, '').split('\n');
    lines.forEach((l, i) => { if (i) document.execCommand('insertParagraph'); if (l) document.execCommand('insertText', false, l); });
  });
  edit.addEventListener('beforeinput', e => { if (e.inputType.startsWith('format')) e.preventDefault(); });

  /** Line blocks touched by the current selection (or the caret's line). */
  let savedRange = null;
  document.addEventListener('selectionchange', onSel);
  function onSel() {
    const s = getSelection();
    if (s.rangeCount && edit.contains(s.getRangeAt(0).commonAncestorContainer)) { savedRange = s.getRangeAt(0).cloneRange(); syncSizeBox(); }
  }
  function blockOf(node) { while (node && node.parentNode !== edit) node = node.parentNode; return node; }
  function selectedBlocks() {
    if (!savedRange) return [];
    const a = blockOf(savedRange.startContainer), b = blockOf(savedRange.endContainer);
    if (!a || !b) return [];
    const kids = [...edit.children], i = kids.indexOf(a), j = kids.indexOf(b);
    return i < 0 || j < 0 ? [] : kids.slice(Math.min(i, j), Math.max(i, j) + 1);
  }
  const sizeOf = div => (div && div.style.fontSize ? parseFloat(div.style.fontSize) : opt.size);

  // Free-entry size: any number from 4 to 300 px, with common sizes suggested.
  const sizeBox = h('input', { type: 'number', min: 4, max: 300, step: 0.5, value: opt.size, list: 'w-sizes', class: 'w-size' });
  const readSize = () => { const v = Math.round(Number(sizeBox.value) * 2) / 2; return v >= 4 && v <= 300 ? v : null; };
  function applySize() {
    const v = readSize();
    if (!v) { syncSizeBox(); return; }
    const blocks = selectedBlocks();
    if (!blocks.length) { opt.size = v; changed(); return; }  // nothing selected yet: page default
    for (const d of blocks) {
      if (v === opt.size) d.style.removeProperty('font-size'); else d.style.fontSize = v + 'px';
    }
    changed();
  }
  sizeBox.addEventListener('change', applySize);
  sizeBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applySize(); } });
  function syncSizeBox() {
    if (document.activeElement === sizeBox) return;
    const blocks = selectedBlocks();
    const sizes = [...new Set(blocks.map(sizeOf))];
    sizeBox.value = sizes.length === 1 ? sizes[0] : sizes.length ? '' : opt.size;
    sizeBox.placeholder = sizes.length > 1 ? 'mixed' : '';
  }

  // ------------------------------------------------------------ margins
  const marginInputs = {};
  const marginSel = h('select', { onchange: e => {
    const p = MARGIN_PRESETS[e.target.value];
    if (p) { Object.assign(opt, { mTop: p.mTop, mBottom: p.mBottom, mLeft: p.mLeft, mRight: p.mRight }); syncMarginUI(); changed(); }
  } }, Object.entries(MARGIN_PRESETS).map(([k, v]) => h('option', { value: k }, v.label)), h('option', { value: 'custom', disabled: true }, 'Custom'));
  const clampM = (key, v) => {
    const other = { mLeft: 'mRight', mRight: 'mLeft', mTop: 'mBottom', mBottom: 'mTop' }[key];
    const total = key === 'mLeft' || key === 'mRight' ? 8.5 : 11;
    return Math.max(0, Math.min(total - opt[other] - 1.5, Math.round(v * 16) / 16)); // keep >= 1.5" of text area
  };
  const marginField = (key, label) => {
    const inp = h('input', { type: 'number', min: 0, max: 4, step: 0.05, value: opt[key], onchange: e => {
      opt[key] = clampM(key, Number(e.target.value) || 0); syncMarginUI(); changed();
    } });
    marginInputs[key] = inp;
    return h('label', { class: 'w-mfield' }, label, inp, h('span', {}, 'in'));
  };
  const marginPanel = h('div', { class: 'card w-panel' }, h('h3', {}, 'Page margins'),
    h('p', { class: 'muted' }, 'In inches. You can also drag the handles on the ruler above the page.'),
    h('div', { class: 'w-mgrid' }, marginField('mTop', 'Top'), marginField('mBottom', 'Bottom'), marginField('mLeft', 'Left'), marginField('mRight', 'Right')));

  // Ruler with draggable left/right margin handles (Word style).
  const handleL = h('div', { class: 'w-handle', title: 'Left margin (drag)' });
  const handleR = h('div', { class: 'w-handle', title: 'Right margin (drag)' });
  const shadeL = h('div', { class: 'w-rshade' }), shadeR = h('div', { class: 'w-rshade' });
  const ticks = h('div', { class: 'w-ticks' });
  for (let i = 0; i <= 8.5 * 8; i++) {
    const x = (i / 8) * DPI, whole = i % 8 === 0, half = i % 4 === 0;
    ticks.append(h('i', { style: { left: x + 'px', height: whole ? '9px' : half ? '6px' : '3px' } }));
    if (whole && i > 0 && i < 68) ticks.append(h('b', { style: { left: x + 'px' } }, String(i / 8)));
  }
  const ruler = h('div', { class: 'w-ruler' }, shadeL, shadeR, ticks, handleL, handleR);
  const drag = (handle, key) => handle.addEventListener('pointerdown', e => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    const rr = ruler.getBoundingClientRect();
    const move = ev => {
      const x = (ev.clientX - rr.left) / DPI;
      opt[key] = clampM(key, key === 'mLeft' ? x : 8.5 - x);
      syncMarginUI(); changed();
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
  drag(handleL, 'mLeft'); drag(handleR, 'mRight');

  // Vertical ruler with top/bottom margin handles.
  const PAGE_H = 11 * DPI;
  const handleT = h('div', { class: 'w-vhandle', title: 'Top margin (drag)' });
  const handleB = h('div', { class: 'w-vhandle', title: 'Bottom margin (drag)' });
  const shadeT = h('div', { class: 'w-vshade' }), shadeB = h('div', { class: 'w-vshade' });
  const vticks = h('div', { class: 'w-vticks' });
  for (let i = 0; i <= 11 * 8; i++) {
    const y = (i / 8) * DPI, whole = i % 8 === 0, half = i % 4 === 0;
    vticks.append(h('i', { style: { top: y + 'px', width: whole ? '9px' : half ? '6px' : '3px' } }));
    if (whole && i > 0 && i < 88) vticks.append(h('b', { style: { top: y + 'px' } }, String(i / 8)));
  }
  const vruler = h('div', { class: 'w-vruler' }, shadeT, shadeB, vticks, handleT, handleB);
  const vdrag = (handle, key) => handle.addEventListener('pointerdown', e => {
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    const rr = vruler.getBoundingClientRect();
    const move = ev => {
      const y = (ev.clientY - rr.top) / DPI;
      opt[key] = clampM(key, key === 'mTop' ? y : 11 - y);
      syncMarginUI(); changed();
    };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
  vdrag(handleT, 'mTop'); vdrag(handleB, 'mBottom');

  function syncMarginUI() {
    const t = opt.mTop * DPI, b = opt.mBottom * DPI;
    handleT.style.top = t + 'px'; handleB.style.top = (PAGE_H - b) + 'px';
    shadeT.style.cssText = `top:0;height:${t}px`; shadeB.style.cssText = `top:${PAGE_H - b}px;height:${b}px`;
    for (const [k, inp] of Object.entries(marginInputs)) if (document.activeElement !== inp) inp.value = opt[k];
    marginSel.value = presetOf(opt);
    const l = opt.mLeft * DPI, r = opt.mRight * DPI;
    handleL.style.left = l + 'px'; handleR.style.left = (PAGE_W - r) + 'px';
    shadeL.style.cssText = `left:0;width:${l}px`; shadeR.style.cssText = `right:0;width:${r}px`;
  }
  const status = h('div', { class: 'w-status' });
  const explorer = h('div', { class: 'w-explorer' });
  const compare = h('div', { class: 'w-compare', hidden: true });

  const sel = (label, key, choices, onChange) => h('label', { class: 'w-field' }, label,
    h('select', { onchange: e => { opt[key] = e.target.value; onChange && onChange(); changed(); } },
      Object.entries(choices).map(([k, v]) => h('option', { value: k, selected: opt[key] === k }, v.label || v))));
  const num = (label, key, min, max, step, fmt, title) => {
    const out = h('output', {}, fmt(opt[key]));
    return h('label', { class: 'w-slider', title }, h('span', {}, label, ' ', out),
      h('input', { type: 'range', min, max, step, value: opt[key], oninput: e => { opt[key] = Number(e.target.value); out.textContent = fmt(opt[key]); changed(); } }));
  };
  const toggle = (label, key, title) => h('button', {
    class: `w-tbtn ${opt[key] ? 'on' : ''}`, title,
    onclick: e => { opt[key] = !opt[key]; e.currentTarget.classList.toggle('on', opt[key]); changed(); },
  }, label);
  const alignBtn = (a, glyph) => h('button', { class: `w-tbtn ${opt.align === a ? 'on' : ''}`, title: `Align ${a}`, onclick: e => {
    opt.align = a; for (const b of e.currentTarget.parentNode.querySelectorAll('.w-align')) b.classList.toggle('on', b === e.currentTarget); changed();
  } }, glyph);

  const toolbar = h('div', { class: 'w-toolbar' },
    h('div', { class: 'w-group' },
      h('label', { class: 'w-field', title: 'Any size. Applies to the line the cursor is on, or every selected line.' }, 'Size', sizeBox),
      h('datalist', { id: 'w-sizes' }, [12, 14, 16, 18, 20, 24, 28, 30, 32, 36, 40, 48, 56, 64, 72, 96].map(s => h('option', { value: s }))),
      h('button', { class: 'w-tbtn', title: 'Use this size for every line', onclick: () => {
        const v = readSize(); if (!v) return;
        opt.size = v; for (const d of edit.children) d.style.removeProperty('font-size'); changed();
      } }, 'All'),
      h('label', { class: 'w-field' }, 'Lines', h('select', { onchange: e => { opt.lineHeight = Number(e.target.value); changed(); } },
        [1.3, 1.5, 1.65, 2.0, 2.4].map(s => h('option', { value: s, selected: opt.lineHeight === s }, s)))),
      Object.assign(alignBtn('left', '≡'), { className: `w-tbtn w-align ${opt.align === 'left' ? 'on' : ''}` }),
      Object.assign(alignBtn('center', '≣'), { className: `w-tbtn w-align ${opt.align === 'center' ? 'on' : ''}` }),
      Object.assign(alignBtn('right', '≢'), { className: `w-tbtn w-align ${opt.align === 'right' ? 'on' : ''}` }),
    ),
    h('div', { class: 'w-group' }, sel('Paper', 'paper', PAPERS), sel('Ink', 'ink', INKS),
      h('label', { class: 'w-field' }, 'Margins', marginSel)),
    h('div', { class: 'w-group' },
      toggle('Natural variation', 'variation', 'The font swaps between 8 versions of every letter as you type'),
      toggle('Version X-ray', 'xray', 'Colour each letter by which of its versions is being used'),
      h('button', { class: 'w-tbtn', title: 'Side-by-side with a static font', onclick: () => { compare.hidden = !compare.hidden; changed(); } }, 'Compare'),
      h('button', { class: 'w-tbtn', title: 'New wobble pattern', onclick: () => { opt.seed = (opt.seed * 1103515245 + 12345) >>> 0; changed(); } }, 'Reroll wobble'),
    ),
    h('div', { class: 'w-group' },
      h('button', { class: 'w-tbtn', onclick: () => { if (confirm('Replace the page with the sample text?')) { setDoc(SAMPLE.split('\n').map(t => ({ t, s: null }))); changed(); } } }, 'Sample text'),
      h('button', { class: 'w-tbtn primary', title: 'Save the page straight to a PDF file (no print dialog)', onclick: async e => {
        const b = e.currentTarget; b.disabled = true; b.textContent = 'Saving…';
        try { await savePDF(); } catch (err) { toast('PDF failed: ' + err.message, 'error'); }
        finally { b.disabled = false; b.textContent = 'Save as PDF'; }
      } }, 'Save as PDF'),
      h('button', { class: 'w-tbtn', onclick: () => window.print(), title: 'Open the print dialog' }, 'Print'),
    ),
  );

  const wobblePanel = h('div', { class: 'card w-panel' },
    h('h3', {}, 'Line wobble'),
    h('p', { class: 'muted' }, 'How a hand moves across a page. The font varies the letters, and these vary the lines.'),
    num('Line tilt', 'tilt', 0, 3, 0.05, v => `±${v.toFixed(2)}°`, 'Each line leans a little differently'),
    num('Baseline drift', 'drift', 0, 10, 0.25, v => `±${v.toFixed(1)}px`, 'Lines ride up and down; consecutive lines are correlated'),
    num('Margin drift', 'margin', 0, 16, 0.5, v => `±${v.toFixed(1)}px`, 'Where each line starts wanders'),
    num('Downhill slope', 'slope', -1, 1.5, 0.05, v => `${v.toFixed(2)}°`, 'Lines slope more as you go down the page'),
    num('Line spacing wander', 'spacing', 0, 8, 0.25, v => `±${v.toFixed(1)}px`),
    num('Ink flow', 'flow', 0, 0.4, 0.01, v => `±${Math.round(v * 100)}%`, 'Pen pressure / ink density varies line to line'),
    h('h3', { style: { marginTop: '14px' } }, 'Word wobble'),
    h('p', { class: 'muted' }, 'Each word sits a little differently on the line.'),
    num('Word bounce', 'wBounce', 0, 8, 0.1, v => `±${v.toFixed(1)}px`, 'Words rise and dip; neighbours move together'),
    num('Word tilt', 'wTilt', 0, 5, 0.05, v => `±${v.toFixed(2)}°`, 'Each word leans on its own'),
    num('Word spacing wander', 'wGap', 0, 6, 0.1, v => `±${v.toFixed(1)}px`, 'Gaps between words vary'),
  );

  const side = h('div', { class: 'w-side' }, wobblePanel, marginPanel,
    h('div', { class: 'card w-panel' }, h('h3', {}, 'Glyph explorer'),
      h('p', { class: 'muted' }, 'Click a letter on the page, or type one here, to see all of its versions.'),
      h('input', { type: 'text', maxlength: 1, placeholder: 'a', class: 'w-pick', oninput: e => e.target.value && showGlyph(e.target.value) }),
      explorer));

  main.append(
    h('div', { class: 'w-wrap' },
      toolbar,
      h('div', { class: 'w-body' }, h('div', { class: 'w-desk' }, h('div', { class: 'w-sheet' }, h('div', { class: 'w-corner' }), ruler, vruler, paper), compare), side),
      status));

  // ---------------------------------------------------------------- font
  async function ensureFont() {
    const b = state.build && state.build.family ? state.build : await ctx.busy('Building your font…', rebuild);
    family = b.family;
    versions = new Map();
    for (const g of b.glyphs) if (!g.ligature && g.char.length === 1) versions.set(g.char, (versions.get(g.char) || 0) + 1);
    changed();
  }

  // ---------------------------------------------------------- rendering
  function changed() {
    save('inkforge.write.opts', opt);
    // A short debounce timer, not requestAnimationFrame: rAF is paused whenever
    // the window isn't painting (minimised, background), which froze the page.
    clearTimeout(raf);
    raf = setTimeout(render, 24);
  }

  function styleText(el) {
    el.style.fontFamily = family ? `"${family}", cursive` : 'cursive';
    el.style.fontSize = opt.size + 'px';
    el.style.lineHeight = opt.lineHeight;
    el.style.fontFeatureSettings = opt.variation ? 'normal' : '"calt" 0';
    el.style.textAlign = opt.align;
  }

  /** Paper geometry shared by the on-screen background and the PDF renderer. */
  function paperGeom() {
    const p = PAPERS[opt.paper], lh = opt.size * opt.lineHeight;
    const m = measureFont();
    const baseOff = (lh - (m.asc + m.desc)) / 2 + m.asc;
    return { p, lh, ml: Math.max(8, opt.mLeft * DPI - 22), y0: opt.mTop * DPI + baseOff - lh + 2 };
  }

  /** Draw the paper (background, rules, margin line, grid) for page rows [top, bottom). */
  function drawPaper(x, top, bottom) {
    const { p, lh, ml, y0 } = paperGeom();
    x.fillStyle = p.bg; x.fillRect(0, top, PAGE_W, bottom - top);
    const mod = (a, b) => ((a % b) + b) % b;
    if (p.rule) {
      x.fillStyle = p.rule;
      for (let y = top - mod(top - (y0 + lh - 1.2), lh); y < bottom; y += lh) x.fillRect(0, y, PAGE_W, 1.2);
    }
    if (p.grid) {
      const g = lh / 2;
      x.fillStyle = p.grid;
      for (let gx = g - 1; gx < PAGE_W; gx += g) x.fillRect(gx, top, 1, bottom - top);
      for (let y = top - mod(top - (y0 + g - 1), g); y < bottom; y += g) x.fillRect(0, y, PAGE_W, 1);
    }
    if (p.margin) { x.fillStyle = p.margin; x.fillRect(ml, top, 2, bottom - top); }
  }

  /** Glyph outline for a character at a given version (falls back to the main version). */
  let glyphIndex = null;
  function glyphFor(ch, v) {
    if (!glyphIndex || glyphIndex.build !== state.build) {
      glyphIndex = { build: state.build, map: new Map() };
      for (const g of state.build.glyphs) if (!g.ligature) glyphIndex.map.set(g.char + '\u0000' + g.version, g);
    }
    return glyphIndex.map.get(ch + '\u0000' + v) || glyphIndex.map.get(ch + '\u0000' + 0) || null;
  }

  /** Render the page(s) exactly as shown and save a PDF (no print dialog). */
  async function savePDF() {
    const S = 3;                         // 96 px/in * 3 = 288 dpi
    const pageH = 11 * DPI;
    const inkDef = INKS[opt.ink];
    const lines = [...ink.querySelectorAll('.w-line')];
    // Pages = where the writing ends (not the bottom margin padding), so no blank last page.
    const lastInk = lines.reduce((m, el) => Math.max(m, +el.dataset.y + +el.dataset.h), 0);
    const nPages = Math.max(1, Math.ceil((lastInk + 2) / pageH));
    const pages = [];
    for (let pg = 0; pg < nPages; pg++) {
      const c = document.createElement('canvas');
      c.width = PAGE_W * S; c.height = pageH * S;
      const x = c.getContext('2d');
      x.scale(S, S); x.translate(0, -pg * pageH);
      drawPaper(x, pg * pageH, (pg + 1) * pageH);
      for (const el of lines) {
        const d = el.dataset, top = +d.y, hgt = +d.h, size = +d.size;
        if (top > (pg + 1) * pageH + 20 || top + hgt < pg * pageH - 20) continue;
        x.save();
        // Same transform as the screen: translate + rotate about (0, 70%) of the line box.
        const ox = +d.x, oy = top + hgt * 0.7;
        x.translate(ox, oy); x.translate(+d.dx, +d.dy); x.rotate((+d.tilt * Math.PI) / 180); x.translate(-ox, -oy);
        x.globalAlpha = +d.alpha;
        if (inkDef.pencil) x.filter = `blur(${0.25 * S}px)`;
        x.fillStyle = inkDef.color;
        x.font = `${size}px "${family}"`;
        x.textBaseline = 'alphabetic';
        const t = x.measureText('Hxgy');
        const asc = t.fontBoundingBoxAscent, desc = t.fontBoundingBoxDescent;
        const base = top + (hgt - (asc + desc)) / 2 + asc;
        const k = size / 1000; // font units -> px
        for (const w of el.querySelectorAll('.w-word')) {
          const wd = w.dataset;
          const wox = ox + +wd.wx, woy = top + hgt * 0.75;   // same origin as the CSS (0 75%)
          x.save();
          x.translate(wox, woy); x.translate(+wd.wdx, +wd.wdy); x.rotate((+wd.wrot * Math.PI) / 180); x.scale(+wd.sx || 1, 1); x.translate(-wox, -woy);
          // Draw the font's own outlines: the exact version and position the page shows
          // (canvas text shaping does not apply the font's version switching the same way).
          const chars = [...wd.word], offs = wd.cx.split(',').map(Number), vers = wd.cv.split(',').map(Number);
          chars.forEach((ch, i) => {
            const g = glyphFor(ch, vers[i]);
            const gx = wox + offs[i];
            if (!g) { x.fillText(ch, gx, base); return; }
            const path = new Path2D();
            for (const c of g.contours) addContour(path, c, (u, v) => [gx + u * k, base - v * k]);
            x.fill(path, 'nonzero');
          });
          x.restore();
        }
        x.restore();
      }
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height });
    }
    const first = ([...edit.children].map(d => d.textContent.trim()).find(Boolean) || 'Inkforge page').slice(0, 60);
    const bytes = imagesToPDF(pages, { title: first });
    const name = first.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, ' ') || 'Inkforge page';
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (window.showSaveFilePicker) {
      try {
        const fh = await showSaveFilePicker({ suggestedName: name + '.pdf', types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
        const w = await fh.createWritable(); await w.write(blob); await w.close();
        toast(`Saved ${fh.name} (${nPages} page${nPages > 1 ? 's' : ''})`, 'good');
        return;
      } catch (e) { if (e.name === 'AbortError') return; }
    }
    download(name + '.pdf', blob);
    toast(`Saved ${name}.pdf to Downloads`, 'good');
  }

  function paperStyle() {
    const p = PAPERS[opt.paper], lh = opt.size * opt.lineHeight;
    const layers = [];
    // Red margin line sits just left of where writing starts.
    const ml = Math.max(8, opt.mLeft * DPI - 22);
    if (p.margin) layers.push(`linear-gradient(90deg, transparent ${ml}px, ${p.margin} ${ml}px, ${p.margin} ${ml + 2}px, transparent ${ml + 2}px)`);
    if (p.rule) layers.push(`repeating-linear-gradient(180deg, transparent 0, transparent ${lh - 1.2}px, ${p.rule} ${lh - 1.2}px, ${p.rule} ${lh}px)`);
    if (p.grid) layers.push(`repeating-linear-gradient(90deg, transparent 0, transparent ${lh / 2 - 1}px, ${p.grid} ${lh / 2 - 1}px, ${p.grid} ${lh / 2}px)`,
      `repeating-linear-gradient(180deg, transparent 0, transparent ${lh / 2 - 1}px, ${p.grid} ${lh / 2 - 1}px, ${p.grid} ${lh / 2}px)`);
    paper.style.backgroundColor = p.bg;
    paper.style.backgroundImage = layers.join(',') || 'none';
    // Put the ruled lines exactly on the text baselines: baseline sits at
    // half-leading + ascent inside each line box (font metrics measured live).
    const m = measureFont();
    const baseOff = (lh - (m.asc + m.desc)) / 2 + m.asc;
    const y0 = opt.mTop * DPI + baseOff - lh + 2; // +2: letters rest on, not through, the rule
    paper.style.backgroundPosition = layers.map((_, i) => (p.margin && i === 0 ? '0 0' : `0 ${y0}px`)).join(',');
    paper.style.setProperty('--lh', lh + 'px');
  }

  // Paragraph-wide version chain, cached per render by line text.
  let paraCache = new Map();
  function paraChainOf(blk, btext) {
    const key = btext.join('');
    if (!paraCache.has(key)) paraCache.set(key, versionsFor(key));
    return paraCache.get(key);
  }
  // Measure a piece of text in the font exactly as the page shapes it.
  let measurer = null;
  function measureWord(text, size) {
    if (!measurer) { measurer = h('span', { class: 'w-measure', 'aria-hidden': 'true' }); document.body.append(measurer); }
    measurer.style.fontFamily = `"${family}"`;
    measurer.style.fontSize = size + 'px';
    measurer.style.fontFeatureSettings = opt.variation ? 'normal' : '"calt" 0';
    measurer.textContent = text;
    return measurer.getBoundingClientRect().width;
  }

  const spaceCache = new Map();
  function spaceWidth(size) {
    const key = family + '|' + size;
    if (!spaceCache.has(key)) {
      const c = document.createElement('canvas').getContext('2d');
      c.font = `${size}px "${family}"`;
      spaceCache.set(key, c.measureText(' ').width);
    }
    return spaceCache.get(key);
  }

  let metricCache = null;
  function measureFont() {
    const key = family + '|' + opt.size;
    if (metricCache && metricCache.key === key) return metricCache;
    const c = document.createElement('canvas').getContext('2d');
    c.font = `${opt.size}px "${family}"`;
    const t = c.measureText('Hxgy');
    metricCache = { key, asc: t.fontBoundingBoxAscent || opt.size * 0.8, desc: t.fontBoundingBoxDescent || opt.size * 0.3 };
    return metricCache;
  }

  function applyMargins() {
    edit.style.padding = `${opt.mTop * DPI}px ${opt.mRight * DPI}px ${opt.mBottom * DPI}px ${opt.mLeft * DPI}px`;
  }

  /** Versions for a run of text — the same formula the font is compiled from. */
  function versionsFor(text) {
    if (!opt.variation) return new Array([...text].length).fill(0);
    return versionChain(text, ch => versions.get(ch) || 1);
  }

  function render() {
    if (!alive) return;
    applyMargins(); styleText(edit); paperStyle();
    paraCache = new Map();
    const inkDef = INKS[opt.ink];
    ink.replaceChildren();
    const pr = paper.getBoundingClientRect();
    // Collect characters with their line boxes from the editable layer.
    const chars = [];
    const walker = document.createTreeWalker(edit, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    const sizeCache = new Map(), blockPos = new Map();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent;
      const blk = blockOf(n);
      if (!sizeCache.has(blk)) sizeCache.set(blk, parseFloat(getComputedStyle(blk && blk.nodeType === 1 ? blk : edit).fontSize) || opt.size);
      const size = sizeCache.get(blk);
      for (let i = 0; i < t.length; i++) {
        const bi = blockPos.get(blk) || 0; blockPos.set(blk, bi + 1); // index of this char in its line's full text
        if (t[i] === '\n') continue;
        range.setStart(n, i); range.setEnd(n, i + 1);
        const rs = range.getClientRects();
        if (!rs.length) continue;
        const r = rs[rs.length - 1];
        chars.push({ ch: t[i], blk, bi, size, x: r.left - pr.left, y: r.top - pr.top, w: r.width, hgt: r.height });
      }
    }
    // Group into visual lines (a new line on wrap, or when a new typed line starts).
    const lines = [];
    let cur = null;
    for (const c of chars) {
      if (!cur || c.blk !== cur.blk || Math.abs(c.y - cur.y) > c.hgt * 0.5) { cur = { y: c.y, h: c.hgt, x: c.x, blk: c.blk, size: c.size, chars: [] }; lines.push(cur); }
      cur.chars.push(c);
    }
    const r = rng(opt.seed);
    let drift = 0, words = 0, letters = 0;
    const H = paper.clientHeight || 1;
    lines.forEach((ln, li) => {
      // Trim trailing spaces from the drawn text (they are invisible anyway).
      const text = ln.chars.map(c => c.ch).join('');
      if (!text.trim()) return;
      words += text.trim().split(/\s+/).length; letters += text.replace(/\s/g, '').length;
      drift = drift * 0.55 + gauss(r) * opt.drift;               // correlated line to line
      const tilt = gauss(r) * opt.tilt + opt.slope * (ln.y / H);  // tired hand slopes downhill
      const dx = gauss(r) * opt.margin;
      const dy = drift + gauss(r) * opt.spacing * 0.5;
      const flow = 1 - Math.abs(gauss(r)) * opt.flow * 0.6;
      const el = h('div', { class: 'w-line' });
      Object.assign(el.dataset, { x: ln.x, y: ln.y, h: ln.h, size: ln.size, dx, dy, tilt, alpha: inkDef.pencil ? flow * 0.85 : flow });
      styleText(el);
      Object.assign(el.style, {
        fontSize: ln.size + 'px', height: ln.h + 'px',
        left: ln.x + 'px', top: ln.y + 'px', lineHeight: ln.h + 'px', textAlign: 'left',
        color: inkDef.color, opacity: String(inkDef.pencil ? flow * 0.85 : flow),
        transform: `translate(${dx}px, ${dy}px) rotate(${tilt}deg)`,
        filter: inkDef.pencil ? 'blur(0.25px)' : 'none',
      });
      // Words: each pinned at its real position in the text (so the caret stays
      // aligned) and given its own bounce / tilt / nudge. Bounce is correlated
      // word to word so the line undulates instead of jittering.
      let bounce = 0;
      // Which version chain did the browser use for this word? On a paragraph's
      // first line it is the paragraph chain; on wrapped lines the browser
      // usually restarts at the line's first letter, but not always. Build both
      // and, per word, keep the one that reproduces the laid-out width.
      const btext = [...ln.blk.textContent];
      const lineStart = ln.chars[0].bi;
      const paraChain = paraChainOf(ln.blk, btext);
      const lineChain = lineStart > 0 ? versionsFor(btext.slice(lineStart).join('')) : null;
      const chains = [{ chain: i => paraChain[i], start: 0 }];
      if (lineChain) chains.push({ chain: i => lineChain[i - lineStart], start: lineStart });
      for (let k = 0; k < ln.chars.length;) {
        if (!ln.chars[k].ch.trim()) { k++; continue; }
        let e = k; while (e < ln.chars.length && ln.chars[e].ch.trim()) e++;
        const wc = ln.chars.slice(k, e), word = wc.map(c => c.ch).join('');
        bounce = bounce * 0.5 + gauss(r) * opt.wBounce * 0.85;
        const wdy = bounce, wrot = gauss(r) * opt.wTilt, wdx = gauss(r) * opt.wGap;
        // The word's piece must continue the font's version chain exactly where
        // the full line text would be: it starts with the character before the
        // word (usually a space), preceded by an invisible zero-width context
        // glyph carrying the state before that. Both take no room on the line.
        const b0 = wc[0].bi;
        const editW = wc[wc.length - 1].x + wc[wc.length - 1].w - wc[0].x; // width the browser laid out
        // Each candidate: the piece starts with the char before the word, preceded
        // by an invisible context glyph carrying the state before that.
        const cands = (opt.variation ? chains : [null]).map(c => {
          if (!c || b0 <= c.start) return { prefix: '', lead: 0, cv: wc.map(ch => (c ? c.chain(ch.bi) : 0)) };
          const pch = btext[b0 - 1];
          const ctx = b0 - 1 > c.start ? contextChar(c.chain(b0 - 2)) : '';
          const pg = glyphFor(pch, c.chain(b0 - 1));
          return { prefix: ctx + pch, lead: pg ? (pg.advance * ln.size) / 1000 : spaceWidth(ln.size), cv: wc.map(ch => c.chain(ch.bi)) };
        });
        let pick = cands[0];
        if (cands.length > 1) {
          let best = Infinity;
          for (const cd of cands) {
            const d = Math.abs(measureWord(cd.prefix + word, ln.size) - cd.lead - editW);
            if (d < best) { best = d; pick = cd; }
          }
        }
        const { prefix, lead, cv } = pick;
        const wx = wc[0].x - ln.x - lead;
        const tw = editW + lead;
        const span = h('span', { class: 'w-word' }, prefix + word);
        // For the PDF: each letter's offset in the word and the font version it uses.
        const cx = wc.map(c => +(c.x - wc[0].x + lead).toFixed(2));
        Object.assign(span.dataset, { wx, wdx, wdy, wrot, tw, sx: 1, word, cx: cx.join(','), cv: cv.join(',') });
        Object.assign(span.style, { left: wx + 'px', transform: `translate(${wdx}px, ${wdy}px) rotate(${wrot}deg)` });
        if (opt.xray) {
          const vs = cv;
          wc.forEach((c, i) => {
            if ((versions.get(c.ch) || 1) < 2) return;
            span.append(h('span', { class: 'w-x', style: { left: (c.x - wc[0].x + lead) + 'px', width: c.w + 'px', background: VCOLORS[vs[i] % VCOLORS.length] }, title: `${c.ch}: version ${vs[i] + 1}` }));
          });
        }
        el.append(span);
        k = e;
      }
      ink.append(el);
    });
    // A word shaped on its own can pick different letter versions (so a
    // different width) than in the flowing text it is pinned to. Fit each word
    // to its slot with a slight horizontal scale so words never collide or gap.
    for (const span of ink.querySelectorAll('.w-word')) {
      const actual = span.offsetWidth, target = +span.dataset.tw;
      if (!actual || !target) continue;
      const sx = Math.max(0.8, Math.min(1.25, target / actual));
      span.dataset.sx = sx;
      span.style.transform += ` scale(${sx}, 1)`;
    }
    status.replaceChildren(...[
      h('span', {}, `${words} words`), h('span', {}, `${letters} letters`), h('span', {}, `${lines.length} lines`),
      h('span', {}, opt.variation ? 'natural variation on' : 'variation off'),
      opt.xray ? h('span', { class: 'w-legend' }, 'versions: ', VCOLORS.map((c, i) => h('i', { style: { background: c }, title: `version ${i + 1}` }))) : null,
      h('span', { class: 'w-saved' }, 'saved'),
    ].filter(Boolean));
    save('inkforge.write.doc2', [...edit.children].map(div => ({ t: div.textContent, s: div.style.fontSize ? parseFloat(div.style.fontSize) : null })));
    if (!compare.hidden) renderCompare();
  }

  function renderCompare() {
    const para = (edit.innerText.split(/\n\s*\n/).find(p => p.trim().length > 60) || edit.innerText).trim().slice(0, 400);
    const mk = (label, fontFamily, feat) => h('div', { class: 'w-cmp' }, h('div', { class: 'label' }, label),
      h('div', { style: { fontFamily, fontSize: Math.min(opt.size, 30) + 'px', lineHeight: 1.5, color: INKS[opt.ink].color, fontFeatureSettings: feat } }, para));
    compare.replaceChildren(
      mk('Your hand, natural variation', `"${family}"`, 'normal'),
      mk('Your hand, one shape per letter', `"${family}"`, '"calt" 0'),
      mk('A normal handwriting-style typeface', '"Segoe Print", "Comic Sans MS", cursive', 'normal'));
  }

  function showGlyph(ch) {
    const b = state.build;
    if (!b) return;
    const gs = b.glyphs.filter(g => g.char === ch && !g.ligature).sort((a, z) => a.version - z.version);
    explorer.replaceChildren();
    if (!gs.length) { explorer.append(h('p', { class: 'muted' }, `No glyph for “${ch}”.`)); return; }
    const inkC = INKS[opt.ink].color;
    explorer.append(h('div', { class: 'w-ghead' }, h('b', { style: { fontFamily: `"${family}"`, fontSize: '34px', color: inkC } }, ch),
      h('small', { class: 'muted' }, `${gs.length} versions · ${gs.filter(g => !g.synthetic).length} from your pages, ${gs.filter(g => g.synthetic).length} synthesized`)));
    const grid = h('div', { class: 'w-ggrid' });
    explorer.append(grid);
    gs.forEach((g, i) => {
      const c = h('canvas', {});
      grid.append(h('div', { class: 'w-gcell', style: { borderColor: VCOLORS[i % VCOLORS.length] } }, c,
        h('small', {}, `v${i + 1}${g.synthetic === 'learned' ? ' · learned' : g.synthetic ? ' · synth' : ' · real'}`)));
      setTimeout(() => drawGlyph(c, g, { color: inkC }), 0);
    });
  }

  // Click a letter on the page -> explore it.
  edit.addEventListener('click', () => {
    const s = getSelection();
    if (!s || !s.focusNode || s.focusNode.nodeType !== 3) return;
    const t = s.focusNode.textContent, i = s.focusOffset;
    const ch = (t[i] && t[i].trim()) ? t[i] : t[i - 1];
    if (ch && ch.trim()) { side.querySelector('.w-pick').value = ch; showGlyph(ch); }
  });
  edit.addEventListener('input', () => { normalize(); changed(); });
  const ro = new ResizeObserver(changed); ro.observe(paper);
  document.fonts.addEventListener?.('loadingdone', changed);

  syncMarginUI();
  ensureFont().then(() => showGlyph('e')).catch(e => toast('Could not build the font: ' + e.message, 'error'));
  return () => { alive = false; ro.disconnect(); clearTimeout(raf); document.removeEventListener('selectionchange', onSel); if (measurer) measurer.remove(); };
}
