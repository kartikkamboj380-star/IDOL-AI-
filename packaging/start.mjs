#!/usr/bin/env node
/**
 * One-command starter for the downloaded IDOL AI package.
 *
 *   node start.mjs          → http://localhost:8787
 *   node start.mjs 9000     → http://localhost:9000
 *
 * Works offline: every dependency is already inside node_modules/.
 * If node_modules is missing (e.g. you unpacked with a tool that skipped it),
 * run `npm install --omit=dev` once first.
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.argv[2] ?? process.env.PORT ?? '8787';

const problems = [];

// Node 20.11 is the floor in package.json. Checking it here turns "SyntaxError:
// Unexpected token" into one sentence the reader can act on, which matters most
// on a phone, where the terminal is 20 columns wide.
const [major, minor] = process.versions.node.split('.').map(Number);
const tooOld = major < 20 || (major === 20 && minor < 11);
if (tooOld) {
  problems.push(
    `Node.js ${process.versions.node} is too old; this needs 20.11 or newer. ` +
      'On Termux: pkg install nodejs-lts',
  );
}

if (!existsSync(path.join(here, 'dist', 'index.html'))) problems.push('dist/index.html is missing (the UI was not built).');
if (!existsSync(path.join(here, 'dist-server', 'server', 'index.js'))) problems.push('dist-server/server/index.js is missing (the server was not built).');
if (!existsSync(path.join(here, 'node_modules', 'express'))) problems.push('node_modules is missing. Run: npm install --omit=dev');

if (problems.length > 0) {
  console.error('\nIDOL AI cannot start:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`
  IDOL AI
  ────────────────────────────────────────
  Open:   http://localhost:${port}
  Mode:   knowledge (no model required)
  Stop:   Ctrl+C
`);

// On Termux (and any phone), "localhost" means the phone itself. The browser on
// the same device can reach it, but another device on the network cannot, so the
// usable address is the LAN one.
if (process.env.PREFIX?.includes('com.termux')) {
  console.log('  On Termux: open http://localhost:' + port + ' in your phone browser.\n');
}

const child = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server/index.js'], {
  cwd: here,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(port), NODE_ENV: process.env.NODE_ENV ?? 'production' },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on('exit', (code) => process.exit(code ?? 0));
