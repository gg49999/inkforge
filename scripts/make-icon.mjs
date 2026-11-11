// Renders the Inkforge logo (ink stroke on a dark rounded square, same as the
// favicon) into PNGs / a multi-size .ico with only Node built-ins.
import fs from 'node:fs';
import zlib from 'node:zlib';

// Design grid 32x32. Stroke follows the favicon path M8 23 c3-1 5-9 8-14 1 5 2 10 8 14.
function strokePoints() {
  const pts = [];
  const cubic = (p0, p1, p2, p3) => {
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, u = 1 - t;
      pts.push([u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]]);
    }
  };
  cubic([8, 23], [11, 22], [13, 14], [16, 9]);
  cubic([16, 9], [17, 14], [18, 19], [24, 23]);
  return pts;
}
const PTS = strokePoints();

function distToStroke(x, y) {
  let best = Infinity;
  for (let i = 1; i < PTS.length; i++) {
    const [ax, ay] = PTS[i - 1], [bx, by] = PTS[i];
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((x - ax) * dx + (y - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t));
  }
  return best;
}

function inRoundRect(x, y, r = 7) {
  if (x < 0 || y < 0 || x > 32 || y > 32) return false;
  const cx = Math.min(Math.max(x, r), 32 - r), cy = Math.min(Math.max(y, r), 32 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size, ss = 5) {
  const out = Buffer.alloc(size * size * 4);
  const s = 32 / size;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const x = (px + (sx + 0.5) / ss) * s, y = (py + (sy + 0.5) / ss) * s;
      if (!inRoundRect(x, y)) continue;
      const ink = distToStroke(x, y) <= 1.55;
      const c = ink ? [244, 239, 230] : [29, 36, 51];
      r += c[0]; g += c[1]; b += c[2]; a++;
    }
    const i = (py * size + px) * 4;
    if (a) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; }
    out[i + 3] = Math.round((a / (ss * ss)) * 255);
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
export function iconPngs(sizes = ICON_SIZES) { return sizes.map(sz => ({ size: sz, png: png(sz, render(sz)) })); }
export function makeIco(file, sizes = ICON_SIZES) {
  const images = iconPngs(sizes).map(i => i.png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((sz, i) => {
    const e = 6 + i * 16;
    header[e] = sz >= 256 ? 0 : sz; header[e + 1] = sz >= 256 ? 0 : sz;
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(file, Buffer.concat([header, ...images]));
  fs.writeFileSync(file.replace(/\.ico$/, '-256.png'), images[images.length - 1]);
}
