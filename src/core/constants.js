// Shared geometry. Every handwriting sample, no matter where it came from
// (template photo, free-form page, pen tablet), is resampled to the same scale:
// one sample pixel = UPP font units, with an explicit baseline row.

export const UPM = 1000;          // font units per em
export const UPP = 4;             // font units per normalized sample pixel

// Default vertical metrics (font units, y up, baseline = 0).
export const METRICS = {
  ascender: 800,
  capHeight: 720,
  xHeight: 500,
  descender: -260,
};

// Writing cell used by printed templates and the draw pad (font units).
// y measured downward from the cell's top edge.
export const CELL = {
  w: 1550,
  h: 1500,
  ascLine: 250,      // ascender / cap guide
  xLine: 550,        // x-height guide
  baseLine: 1050,    // baseline guide
  descLine: 1320,    // descender guide
  margin: 60,        // ignored border inside each cell
};

export const LOWER = 'abcdefghijklmnopqrstuvwxyz';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const DIGITS = '0123456789';
export const PUNCT = `.,;:!?'"-()&/@#$%*+=_[]<>~^{}|\\\``;
export const EXTRA = '’“”—…'; // ’ “ ” — …

export const CHARSET = LOWER + UPPER + DIGITS + PUNCT + EXTRA;

export const DEFAULT_LIGATURES = ['th', 'ff', 'll', 'tt', 'oo', 'ee', 'st', 'fi', 'ss', 'ck'];

/** Zones a character normally occupies — used to sanity-check samples. */
export function zoneOf(ch) {
  if ('acemnorsuvwxz'.includes(ch)) return 'x';
  if ('bdhklt'.includes(ch) || UPPER.includes(ch) || DIGITS.includes(ch) || 'f'.includes(ch)) return 'asc';
  if ('gpqy'.includes(ch)) return 'desc';
  if (ch === 'j') return 'desc';
  if (ch === 'i') return 'x';
  return 'any';
}

export function glyphNameFor(ch) {
  const cp = ch.codePointAt(0);
  if (/^[A-Za-z0-9]$/.test(ch)) return ch;
  return 'uni' + cp.toString(16).toUpperCase().padStart(4, '0');
}
