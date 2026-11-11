// Open Inkforge for the user: an app-style window (Edge or Chrome --app) when
// possible, otherwise the default browser.
import { existsSync } from 'node:fs';
import { spawn, exec } from 'node:child_process';
import { join } from 'node:path';

function findAppBrowser() {
  if (process.platform !== 'win32') return null;
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  for (const r of rel) for (const base of pf) { const p = join(base, ...r); if (existsSync(p)) return p; }
  return null;
}

export function openApp(url, { appWindow = true } = {}) {
  const browser = appWindow ? findAppBrowser() : null;
  if (browser) {
    spawn(browser, [`--app=${url}`, '--window-size=1400,950'], { detached: true, stdio: 'ignore' }).unref();
    return 'app';
  }
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
  return 'browser';
}
