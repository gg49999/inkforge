// Minimal PDF writer: one full-page JPEG image per page (DCTDecode, so the
// JPEG bytes are embedded as-is). Zero dependencies.

/**
 * pages: [{ jpeg: Uint8Array, width: px, height: px }]
 * size: page size in points (default US Letter 612 x 792).
 * Returns Uint8Array of a valid PDF 1.4 file.
 */
export function imagesToPDF(pages, { size = [612, 792], title = 'Inkforge', author = '' } = {}) {
  const enc = new TextEncoder();
  const chunks = [];
  let length = 0;
  const offsets = [];
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); length += b.length; };
  const esc = s => s.replace(/[\\()]/g, m => '\\' + m).replace(/[^\x20-\x7e]/g, '');
  const n = pages.length;
  // Object numbering: 1 catalog, 2 pages, 3 info, then per page: page, content, image.
  const pageObj = i => 4 + i * 3, contentObj = i => 5 + i * 3, imageObj = i => 6 + i * 3;
  const total = 3 + n * 3;
  const obj = (num, body) => { offsets[num] = length; push(`${num} 0 obj\n`); for (const part of [].concat(body)) push(part); push('\nendobj\n'); };

  push('%PDF-1.4\n%âãÏÓ\n'); // high-bit comment marks the file as binary
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  const now = new Date(), pad = v => String(v).padStart(2, '0');
  const date = `D:${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  obj(3, `<< /Title (${esc(title)}) /Author (${esc(author)}) /Producer (Inkforge) /CreationDate (${date}) >>`);
  const [W, H] = size;
  pages.forEach((p, i) => {
    obj(pageObj(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im0 ${imageObj(i)} 0 R >> >> /Contents ${contentObj(i)} 0 R >>`);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`;
    obj(contentObj(i), [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(imageObj(i), [`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
  });
  const xref = length;
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= total; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
