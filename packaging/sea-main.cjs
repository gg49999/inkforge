// Bootstrap for Inkforge.exe (Node single-executable application).
// Every app file is embedded as an asset; on first run (or after an update)
// they are unpacked to a versioned folder, then the normal server starts from
// disk and Inkforge opens in its own app window. The exe has no console:
// the server exits by itself a few minutes after the last window closes.
const sea = require('node:sea');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

process.env.INKFORGE_PACKAGED = '1';
const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const dataDir = path.join(base, 'Inkforge');
const logFile = path.join(dataDir, 'inkforge.log');
const log = (msg) => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch {} };
process.on('uncaughtException', (e) => { log('crash: ' + (e && e.stack || e)); process.exit(1); });

const manifest = JSON.parse(sea.getAsset('manifest.json', 'utf8'));
const root = path.join(dataDir, 'runtime', `${manifest.version}-${manifest.hash}`);

if (!fs.existsSync(path.join(root, '.complete'))) {
  const tmp = `${root}.tmp-${process.pid}`;
  for (const file of manifest.files) {
    const dest = path.join(tmp, ...file.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(sea.getAsset(file)));
  }
  fs.writeFileSync(path.join(tmp, '.complete'), new Date().toISOString());
  try { fs.mkdirSync(path.dirname(root), { recursive: true }); fs.renameSync(tmp, root); }
  catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  try {
    for (const d of fs.readdirSync(path.dirname(root))) {
      const full = path.join(path.dirname(root), d);
      if (full !== root) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {}
}

const load = createRequire(path.join(root, 'bootstrap.js'));
const { startServer, alreadyRunning } = load('./src/server.js');
const { openApp } = load('./src/launch.js');
const port = 7431, url = `http://127.0.0.1:${port}/`;

(async () => {
  if (await alreadyRunning(port)) { openApp(url); return; } // second click: just open a window
  try {
    await startServer({ root: path.join(root, 'src'), port, dataDir, version: manifest.version, idleExitMs: 4 * 60 * 1000 });
  } catch (e) {
    log('could not start server: ' + (e && e.message));
    process.exit(1);
  }
  log(`started ${manifest.version} at ${url}`);
  openApp(url);
})();
