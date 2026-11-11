// Builds reports/learn-eval/index.html from metrics.json (+ sheet PNGs, inlined).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'reports', 'learn-eval');
const R = JSON.parse(fs.readFileSync(path.join(OUT, 'metrics.json'), 'utf8'));
const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const num = (v, d = 2) => (v == null ? '—' : v.toFixed(d));
const img = f => `data:image/png;base64,${fs.readFileSync(path.join(OUT, f)).toString('base64')}`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Scores: closer to the ideal is better. Colour a cell green/amber/red by how close.
function grade(v, ideal, ok, bad) {
  if (v == null) return '';
  const d = Math.abs(v - ideal);
  return d <= ok ? 'good' : d >= bad ? 'bad' : 'mid';
}

function summaryRow(s, name, note) {
  const x = s.summary;
  return `<tr><th>${esc(name)}<small>${esc(note || '')}</small></th>
  <td class="${grade(x.nnLearned, 0.5, 0.12, 0.3)}">${pct(x.nnLearned)}</td><td class="${grade(x.nnBaseline, 0.5, 0.12, 0.3)}">${pct(x.nnBaseline)}</td><td class="muted">${pct(x.nnRealVsReal)}</td>
  <td class="${grade(x.noveltyLearned, 1, 0.2, 0.6)}">${num(x.noveltyLearned)}</td><td class="${grade(x.noveltyBaseline, 1, 0.2, 0.6)}">${num(x.noveltyBaseline)}</td>
  <td class="${grade(x.offsetLearned, 0, 0.35, 1)}">${num(x.offsetLearned)}</td><td class="${grade(x.offsetBaseline, 0, 0.35, 1)}">${num(x.offsetBaseline)}</td>
  <td class="${grade(x.spreadErrLearned, 0, 0.3, 0.8)}">${num(x.spreadErrLearned)}</td><td class="${grade(x.spreadErrBaseline, 0, 0.3, 0.8)}">${num(x.spreadErrBaseline)}</td>
  <td class="${grade(x.heldOutEV, 1, 0.3, 0.6)}">${pct(x.heldOutEV)}</td></tr>`;
}

function letterTable(s) {
  const rows = Object.entries(s.letters).map(([ch, l]) => {
    const rec = l.recovery ? Object.entries(l.recovery).map(([k, v]) => `${k} ${Math.round(v.corr * 100)}%<sub>p${v.mode}</sub>`).join(' · ') : '';
    return `<tr><th class="ch">${esc(ch)}</th><td>${l.ownModel ? `own (${l.patterns})` : 'general habits'}</td>
    <td class="${grade(l.nn.learned, 0.5, 0.12, 0.3)}">${pct(l.nn.learned)}</td><td class="${grade(l.nn.baseline, 0.5, 0.12, 0.3)}">${pct(l.nn.baseline)}</td>
    <td class="${grade(l.novelty.learned, 1, 0.2, 0.6)}">${num(l.novelty.learned)}</td><td class="${grade(l.novelty.baseline, 1, 0.2, 0.6)}">${num(l.novelty.baseline)}</td>
    <td>${pct(l.heldOutEV)}</td><td class="rec">${rec}</td></tr>`;
  }).join('');
  return `<table class="letters"><thead><tr><th></th><th>model</th><th>1-NN learned</th><th>1-NN previous</th><th>novelty learned</th><th>novelty previous</th><th>unseen explained</th><th>ground-truth recovery (best pattern)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function curveTable(s) {
  if (!s.curve) return '';
  const ns = Object.keys(s.curve);
  return `<table class="curve"><thead><tr><th>training copies</th>${ns.map(n => `<th>${n}</th>`).join('')}</tr></thead><tbody>
  <tr><th>unseen variation explained</th>${ns.map(n => `<td>${pct(s.curve[n].heldOutEV)}</td>`).join('')}</tr>
  <tr><th>1-NN vs unseen (50% ideal)</th>${ns.map(n => `<td>${pct(s.curve[n].nn)}</td>`).join('')}</tr></tbody></table>`;
}

function section(s, real = false) {
  return `<section><h2>${esc(s.name)}</h2><p class="note">${esc(s.note || '')} · model trained in ${(s.trainMs / 1000).toFixed(1)}s</p>
  <div class="sheet"><div class="groups"><span>Training (real)</span><span>Held-out (real, never seen)</span><span>Learned model</span><span>Previous method</span></div>
  <div class="rows"><div class="labels">${s.rowLabels.map(c => `<span>${esc(c)}</span>`).join('')}</div><img src="${img(s.image)}" alt="${esc(s.name)} samples"></div></div>
  ${letterTable(s)}${real ? '' : curveTable(s)}</section>`;
}

const all = [...R.styles, ...(R.real ? [R.real] : [])];
const avgOf = (k) => { const v = R.styles.map(s => s.summary[k]).filter(x => x != null); return v.reduce((a, b) => a + b, 0) / v.length; };
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model evaluation</title><style>
:root{--bg:#f6f3ec;--card:#fffdf8;--ink:#1d2433;--muted:#6b7280;--line:#e2dccf;--good:#d9f2e2;--mid:#fbefcf;--bad:#f8d9d4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14171f;--card:#1b1f29;--ink:#ece6da;--muted:#9aa0ad;--line:#2d3342;--good:#1f4a33;--mid:#4d4220;--bad:#5a2a26}}
:root[data-theme=dark]{--bg:#14171f;--card:#1b1f29;--ink:#ece6da;--muted:#9aa0ad;--line:#2d3342;--good:#1f4a33;--mid:#4d4220;--bad:#5a2a26}
body{margin:0;background:var(--bg);color:var(--ink);font:14.5px/1.5 system-ui,sans-serif}
main{max-width:1260px;margin:0 auto;padding:28px 16px 80px}
h1{font:600 30px Georgia,serif;margin:0 0 6px}h2{font:600 21px Georgia,serif;margin:0 0 4px}
.lede{color:var(--muted);max-width:80ch}
section,.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:18px 0;overflow-x:auto}
table{border-collapse:collapse;font-size:13px;margin-top:12px}th,td{padding:5px 9px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
thead th{font-weight:600;color:var(--muted);font-size:12px}tbody th small{display:block;font-weight:400;color:var(--muted)}
td.good{background:var(--good)}td.mid{background:var(--mid)}td.bad{background:var(--bad)}td.muted{color:var(--muted)}
.ch{font:20px Georgia,serif}.rec{white-space:normal;max-width:380px;color:var(--muted)}
.note{color:var(--muted);margin:0 0 10px}
.sheet{overflow-x:auto}.groups{display:flex;padding-left:24px}.groups span{width:326px;flex:none;font-size:12px;font-weight:600;color:var(--muted)}
.rows{display:flex}.labels{display:flex;flex-direction:column;width:24px;flex:none}.labels span{height:64px;line-height:64px;font:16px Georgia,serif;color:var(--muted)}
.sheet img{display:block;border-radius:6px;background:#fff}
.key{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.key div{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.key b{display:block}.big{font:600 26px Georgia,serif}
</style></head><body><main>
<h1>Learned handwriting model: evaluation</h1>
<p class="lede">Six synthetic writers with known variation, plus your own handwriting. For each letter the model trains on 20 copies (half of yours) and is tested against copies it has never seen. "Previous method" is the old approach (random tilt, size, wobble and pressure applied to real copies). Generated ${esc(new Date(R.generated).toLocaleString())}.</p>
<div class="card key">
<div><b>1-NN two-sample test</b>Mix generated copies with unseen real ones; for each, is its nearest neighbour the same kind? <b>50%</b> = indistinguishable, 100% = obviously different. Real-vs-real shown for reference.</div>
<div><b>Novelty</b>How far generated copies sit from the training copies, relative to how far genuinely new real copies sit. <b>1.0</b> = as new as a real copy, below = copying, far above = off-style.</div>
<div><b>Feature offset / spread error</b>Width, height, slant and ink weight vs the unseen real copies: mean offset in standard deviations (<b>0</b> ideal) and log spread ratio (<b>0</b> = same variability).</div>
<div><b>Unseen explained</b>How much of the variation of copies the model never saw its patterns can express. <b>Ground-truth recovery</b>: correlation between a learned pattern and a true cause of variation (synthetic writers only).</div>
</div>
<div class="card key">
<div><span class="big">${pct(avgOf('nnLearned'))}</span>1-NN, learned (synthetic avg) vs <b>${pct(avgOf('nnBaseline'))}</b> previous method</div>
<div><span class="big">${num(avgOf('noveltyLearned'))}</span>novelty, learned vs <b>${num(avgOf('noveltyBaseline'))}</b> previous</div>
<div><span class="big">${num(avgOf('spreadErrLearned'))}</span>spread error, learned vs <b>${num(avgOf('spreadErrBaseline'))}</b> previous</div>
<div><span class="big">${pct(avgOf('heldOutEV'))}</span>of unseen copies' variation explained</div>
</div>
<section><h2>Summary</h2><table><thead><tr><th></th><th>1-NN learned</th><th>1-NN previous</th><th>1-NN real vs real</th><th>novelty learned</th><th>novelty previous</th><th>offset learned</th><th>offset previous</th><th>spread err learned</th><th>spread err previous</th><th>unseen explained</th></tr></thead>
<tbody>${all.map(s => summaryRow(s, s.name, s.note)).join('')}</tbody></table></section>
${R.styles.map(s => section(s)).join('')}
${R.real ? section(R.real, true) : ''}
</main></body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log('wrote', path.join(OUT, 'index.html'));
