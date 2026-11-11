// IndexedDB persistence for samples and project settings, plus project
// import/export (.inkforge.json with 8-bit ink).

const DB = 'inkforge', VER = 1;
let dbp = null;

function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('samples')) d.createObjectStore('samples', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}

export const store = {
  allSamples: () => tx('samples', 'readonly', s => s.getAll()),
  putSamples: (list) => tx('samples', 'readwrite', s => { for (const x of list) s.put(x); }),
  deleteSamples: (ids) => tx('samples', 'readwrite', s => { for (const id of ids) s.delete(id); }),
  clearSamples: () => tx('samples', 'readwrite', s => s.clear()),
  getMeta: (k) => tx('meta', 'readonly', s => s.get(k)),
  setMeta: (k, v) => tx('meta', 'readwrite', s => s.put(v, k)),
};

function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(str) {
  const s = atob(str), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function exportProject(samples, meta) {
  return JSON.stringify({
    format: 'inkforge-project', version: 1, exported: new Date().toISOString(), meta,
    samples: samples.map(s => ({
      id: s.id, char: s.char, w: s.w, h: s.h, baseline: s.baseline, source: s.source, created: s.created,
      favorite: !!s.favorite, disabled: !!s.disabled,
      ink: b64(Uint8Array.from(s.ink, v => Math.round(Math.max(0, Math.min(1, v)) * 255))),
    })),
  });
}

export function importProject(text) {
  const j = JSON.parse(text);
  if (j.format !== 'inkforge-project') throw new Error('Not an Inkforge project file.');
  return {
    meta: j.meta || {},
    samples: j.samples.map(s => ({ ...s, ink: Float32Array.from(unb64(s.ink), v => v / 255) })),
  };
}
