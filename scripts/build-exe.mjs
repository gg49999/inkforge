// Builds dist/Inkforge.exe: a self-contained, double-click desktop app.
//   npm install          (dev tool: postject)
//   npm run build:exe
// Node single-executable application + embedded app files + icon/version
// resources (Win32 UpdateResource, no third-party binaries) + GUI subsystem
// so no console window appears.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeIco, iconPngs } from './make-icon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const step = (m) => console.log(`\x1b[36m›\x1b[0m ${m}`);
if (process.platform !== 'win32') throw new Error('Inkforge.exe is built on Windows');

/** VS_VERSIONINFO resource. */
function versionInfo(version, strings) {
  const [a = 0, b = 0, c = 0, d = 0] = version.split('.').map(Number);
  const utf16z = (s) => Buffer.from(s + '\0', 'utf16le');
  const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf);
  const block = (key, value, type, valueLen, children = []) => {
    let buf = pad4(Buffer.concat([Buffer.alloc(6), utf16z(key)]));
    if (value) buf = Buffer.concat([buf, value]);
    for (const ch of children) buf = Buffer.concat([pad4(buf), ch]);
    buf.writeUInt16LE(buf.length, 0); buf.writeUInt16LE(valueLen, 2); buf.writeUInt16LE(type, 4);
    return buf;
  };
  const fixed = Buffer.alloc(52);
  [0xfeef04bd, 0x00010000, (a << 16) | b, (c << 16) | d, (a << 16) | b, (c << 16) | d, 0x3f, 0, 0x40004, 1, 0, 0, 0]
    .forEach((v, i) => fixed.writeUInt32LE(v >>> 0, i * 4));
  const strs = Object.entries(strings).map(([k, v]) => block(k, utf16z(v), 1, v.length + 1));
  const table = block('040904B0', null, 1, 0, strs);
  const sfi = block('StringFileInfo', null, 1, 0, [table]);
  const trans = Buffer.alloc(4); trans.writeUInt16LE(0x0409, 0); trans.writeUInt16LE(0x04b0, 2);
  const vfi = block('VarFileInfo', null, 1, 0, [block('Translation', trans, 0, 4)]);
  return block('VS_VERSION_INFO', pad4(fixed), 0, 52, [sfi, vfi]);
}

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Files to embed (never personal data: src/_local is excluded).
step('Collecting application files');
const files = [];
const walk = (rel) => {
  for (const ent of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const r = path.posix.join(rel, ent.name);
    if (r === 'src/_local') continue;
    if (ent.isDirectory()) walk(r); else files.push(r);
  }
};
walk('src');
files.push('package.json');
const hash = crypto.createHash('sha256');
for (const f of files) hash.update(f).update(fs.readFileSync(path.join(ROOT, f)));
const manifest = { version: pkg.version, hash: hash.digest('hex').slice(0, 12), files };
fs.writeFileSync(path.join(BUILD, 'manifest.json'), JSON.stringify(manifest));
console.log(`  ${files.length} files, content hash ${manifest.hash}`);

// 2. SEA blob.
step('Generating SEA blob');
const assets = { 'manifest.json': path.join(BUILD, 'manifest.json') };
for (const f of files) assets[f] = path.join(ROOT, f);
const seaConfig = {
  main: path.join(ROOT, 'packaging', 'sea-main.cjs'),
  output: path.join(BUILD, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false, assets,
};
fs.writeFileSync(path.join(BUILD, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(BUILD, 'sea-config.json')], { stdio: 'inherit' });

// 3. Node runtime copy.
const out = path.join(DIST, 'Inkforge.exe');
step(`Copying Node ${process.version} runtime -> ${path.relative(ROOT, out)}`);
fs.rmSync(out, { force: true });
fs.copyFileSync(process.execPath, out);

// 4. Icon + version resources.
step('Writing icon and version resources');
makeIco(path.join(BUILD, 'inkforge.ico'));
const res = path.join(BUILD, 'res');
fs.mkdirSync(res);
const LANG = 1033, lines = [];
const icons = iconPngs();
const group = Buffer.alloc(6 + 14 * icons.length);
group.writeUInt16LE(0, 0); group.writeUInt16LE(1, 2); group.writeUInt16LE(icons.length, 4);
icons.forEach(({ size, png }, i) => {
  const file = path.join(res, `icon-${size}.png`);
  fs.writeFileSync(file, png);
  lines.push(`3|${i + 1}|${LANG}|${file}`);
  const e = 6 + i * 14;
  group[e] = size >= 256 ? 0 : size; group[e + 1] = size >= 256 ? 0 : size;
  group.writeUInt16LE(1, e + 4); group.writeUInt16LE(32, e + 6);
  group.writeUInt32LE(png.length, e + 8); group.writeUInt16LE(i + 1, e + 12);
});
fs.writeFileSync(path.join(res, 'group.bin'), group);
lines.push(`14|1|${LANG}|${path.join(res, 'group.bin')}`);
fs.writeFileSync(path.join(res, 'version.bin'), versionInfo(pkg.version, {
  FileDescription: 'Inkforge', ProductName: 'Inkforge', CompanyName: 'Inkforge',
  LegalCopyright: 'MIT License', OriginalFilename: 'Inkforge.exe', InternalName: 'inkforge',
  FileVersion: pkg.version, ProductVersion: pkg.version,
}));
lines.push(`16|1|${LANG}|${path.join(res, 'version.bin')}`);
fs.writeFileSync(path.join(res, 'spec.txt'), lines.join('\n'));
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
  path.join(ROOT, 'packaging', 'win-resources.ps1'), '-Exe', out, '-Spec', path.join(res, 'spec.txt')], { stdio: 'inherit' });

// 5. Inject the app.
step('Injecting application');
const postjectPath = path.join(ROOT, 'node_modules', 'postject', 'dist', 'api.js');
if (!fs.existsSync(postjectPath)) throw new Error('postject is missing: run `npm install` first');
const postject = await import(pathToFileURL(postjectPath).href);
const inject = postject.inject || postject.default?.inject;
await inject(out, 'NODE_SEA_BLOB', fs.readFileSync(seaConfig.output), { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' });

// 6. GUI subsystem: double-clicking shows no console window.
step('Switching to the Windows GUI subsystem (no console window)');
const fd = fs.openSync(out, 'r+');
const hdr = Buffer.alloc(4); fs.readSync(fd, hdr, 0, 4, 0x3c);
const pe = hdr.readUInt32LE(0);
const sig = Buffer.alloc(4); fs.readSync(fd, sig, 0, 4, pe);
if (sig.toString('latin1') !== 'PE\0\0') throw new Error('not a PE file');
const subsystemAt = pe + 4 + 20 + 68;                // PE sig + COFF header + optional header offset
const sub = Buffer.alloc(2); fs.readSync(fd, sub, 0, 2, subsystemAt);
if (sub.readUInt16LE(0) !== 3) throw new Error('unexpected subsystem ' + sub.readUInt16LE(0));
sub.writeUInt16LE(2, 0); fs.writeSync(fd, sub, 0, 2, subsystemAt);
fs.closeSync(fd);

const mb = (fs.statSync(out).size / 1048576).toFixed(1);
console.log(`\n\x1b[32m✔\x1b[0m Built ${path.relative(ROOT, out)} (${mb} MB)`);
