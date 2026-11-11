// Inkforge local server (zero dependencies). Used by `node bin/inkforge.js`
// and by the packaged Inkforge.exe.
//
// Besides serving the app it keeps the project on disk, so the library is not
// tied to one browser's storage:
//   GET  /api/ping      -> { app: 'inkforge', version }
//   GET  /api/project   -> saved project JSON (404 if none)
//   PUT  /api/project   <- project JSON (written atomically)

import { createServer } from 'node:http';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff': 'font/woff', '.pdf': 'application/pdf', '.jpg': 'image/jpeg',
};

export function defaultDataDir() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : (process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'));
  return join(base, 'Inkforge');
}

const isLocal = a => /^127\.|^::1$|^::ffff:127\./.test(a || '');

export function startServer({ root, port = 7431, host = '127.0.0.1', dataDir = defaultDataDir(), version = '0.0.0', devSave = false, idleExitMs = 0 } = {}) {
  root = resolve(root);
  const projectFile = join(dataDir, 'project.json');
  // Desktop mode: the open app pings us; once nothing has talked to the
  // server for idleExitMs (window closed), it shuts itself down.
  let lastSeen = Date.now();
  if (idleExitMs) setInterval(() => { if (Date.now() - lastSeen > idleExitMs) process.exit(0); }, 15000).unref();

  const server = createServer(async (req, res) => {
    lastSeen = Date.now();
    try {
      const url = new URL(req.url, 'http://x');
      // The project API only answers this machine.
      if (url.pathname.startsWith('/api/')) {
        if (!isLocal(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
        if (url.pathname === '/api/ping') return json(res, 200, { app: 'inkforge', version });
        if (url.pathname === '/api/project' && req.method === 'GET') {
          const body = await readFile(projectFile).catch(() => null);
          if (!body) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no project"}'); return; }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
          return;
        }
        if (url.pathname === '/api/project' && req.method === 'PUT') {
          const chunks = []; let size = 0;
          for await (const c of req) { size += c.length; if (size > 200 * 1048576) { res.writeHead(413).end(); return; } chunks.push(c); }
          const body = Buffer.concat(chunks);
          const parsed = JSON.parse(body.toString('utf8'));
          if (parsed.format !== 'inkforge-project') return json(res, 400, { error: 'not an Inkforge project' });
          await mkdir(dataDir, { recursive: true });
          const tmp = projectFile + '.tmp';
          await writeFile(tmp, body);
          await rename(tmp, projectFile);
          return json(res, 200, { ok: true, samples: parsed.samples.length, bytes: body.length });
        }
        res.writeHead(404).end(); return;
      }
      // Dev helper (only when started with devSave): write debug images/fonts into src/_local.
      if (devSave && req.method === 'POST' && url.pathname === '/_dev/save') {
        const name = url.searchParams.get('name') || '';
        if (!/^[A-Za-z0-9_-]{1,60}\.(png|ttf|pdf)$/.test(name) || !isLocal(req.socket.remoteAddress)) { res.writeHead(403).end(); return; }
        const chunks = []; for await (const c of req) chunks.push(c);
        const b64 = Buffer.concat(chunks).toString('latin1').replace(/^data:[a-z/+-]+;base64,/, '');
        await mkdir(join(root, '_local'), { recursive: true });
        await writeFile(join(root, '_local', name), Buffer.from(b64, 'base64'));
        res.writeHead(204).end(); return;
      }
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const file = normalize(join(root, path));
      if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
      res.end(await readFile(file));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(e && e.message || e));
    }
  });

  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok({ server, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`, dataDir }));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
}

/** Is an Inkforge server already answering on this port? */
export async function alreadyRunning(port, host = '127.0.0.1') {
  try {
    const r = await fetch(`http://${host}:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    return j.app === 'inkforge';
  } catch { return false; }
}
