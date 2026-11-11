// The version-picking formula, shared by the font builder (which compiles it
// into the font's GSUB 'calt' rules) and the app (Write tab, X-ray, PDF), so
// both always agree on which version of a character is drawn.
//
// Model: every glyph carries a "state" = its version index. The next glyph's
// version is a function of (its character group, the previous glyph's state).
//   * Each group follows its own randomly shuffled single cycle through all n
//     versions, so a repeated letter visits every version, in scrambled order,
//     before any repeats, and never shows the same version twice in a row.
//   * Characters are spread across many groups, so different letters jump
//     through the cycle differently; the sequence looks random, not stepped.
//   * Spaces have versions too and pass the state along, so the same word
//     comes out differently depending on everything written before it.
// The first glyph of a run (no previous glyph) uses its main version (0).

import { hashString, rng } from './raster.js';

export const GROUPS = 24;
/**
 * Codepoints mapped to zero-width "context" glyphs, one per state. They must be
 * Latin-script characters: browsers split text into runs by script, and a
 * private-use or symbol character would break the run (and the version chain)
 * right after it. These are rarely used Latin letters: Latin Extended-E
 * phonetic letters U+AB30–AB5A, then Latin Extended-D U+A730–A76F.
 */
export const CONTEXT_CODES = [
  ...Array.from({ length: 0xAB5A - 0xAB30 + 1 }, (_, i) => 0xAB30 + i),
  ...Array.from({ length: 0xA76F - 0xA730 + 1 }, (_, i) => 0xA730 + i),
];
export const MAX_VERSIONS = 64;
/** The context character that puts the version chain in state j. */
export const contextChar = j => String.fromCharCode(CONTEXT_CODES[j]);

export function groupOf(ch) { return hashString('grp:' + ch) % GROUPS; }

const cycles = new Map();
/** Successor table of a random single n-cycle for group g. */
function cycle(g, n) {
  const key = g + ':' + n;
  let next = cycles.get(key);
  if (next) return next;
  const order = Array.from({ length: n }, (_, i) => i);
  const r = rng(hashString(`cycle:${g}:${n}`));
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  next = new Int32Array(n);
  for (let i = 0; i < n; i++) next[order[i]] = order[(i + 1) % n];
  cycles.set(key, next);
  return next;
}

/**
 * Version for a glyph of character `ch` (with n versions) after a glyph whose
 * state is `prev` (-1 = nothing before it). States may exceed n (another
 * character can have more versions); they are folded in with a group offset.
 */
export function pickVersion(ch, prev, n) {
  if (prev < 0 || n < 2) return 0;
  const g = groupOf(ch);
  // Successor in this group's shuffled cycle. (A state from a character with
  // more versions than n is folded in.) Repeated letters therefore walk the
  // whole cycle: all n versions, scrambled, no immediate repeats.
  const p = prev < n ? prev : (prev + g * 7) % n;
  return cycle(g, n)[p];
}

/** Versions for a whole run of text. versionsOf: char -> version count. */
export function versionChain(text, versionsOf, { startState = -1 } = {}) {
  const out = [];
  let prev = startState;
  for (const ch of text) {
    const v = pickVersion(ch, prev, versionsOf(ch));
    out.push(v);
    prev = v;
  }
  return out;
}
