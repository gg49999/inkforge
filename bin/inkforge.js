#!/usr/bin/env node
// Inkforge: node bin/inkforge.js [--port 7431] [--open] [--app] [--dev]
//   --open  open in the default browser
//   --app   open as a standalone app window (Edge/Chrome app mode), else browser
//   --dev   enable the local debug-image endpoint (writes into src/_local)
// Environment: PORT, INKFORGE_DATA (folder for project.json; default %LOCALAPPDATA%\Inkforge)
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { startServer, alreadyRunning } from '../src/server.js';
import { openApp } from '../src/launch.js';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || Number(process.env.PORT) || 7431;
const root = fileURLToPath(new URL('../src/', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const url = `http://127.0.0.1:${port}/`;

if (await alreadyRunning(port)) {
  console.log(`Inkforge is already running at ${url}`);
  if (args.includes('--open') || args.includes('--app')) openApp(url, { appWindow: args.includes('--app') });
} else {
  await startServer({
    root, port, version,
    devSave: args.includes('--dev'),
    ...(process.env.INKFORGE_DATA ? { dataDir: process.env.INKFORGE_DATA } : {}),
  });
  console.log(`Inkforge ${version} running at ${url}`);
  if (args.includes('--open') || args.includes('--app')) openApp(url, { appWindow: args.includes('--app') });
}
