#!/usr/bin/env node
/**
 * Verifies this package on your machine before you trust it.
 *
 *   node scripts/verify.mjs
 *
 * Starts the server on a scratch port, runs the journey checks, then shuts it
 * down. Exits non-zero if anything fails.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 8899;
const base = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, ['--enable-source-maps', 'dist-server/server/index.js'], {
  cwd: here,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PORT: String(port), NODE_ENV: 'production', IDOL_DATA_DIR: path.join(here, '.data-verify') },
});

let log = '';
server.stdout.on('data', (chunk) => {
  log += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  log += chunk.toString();
});

const cleanup = () => {
  try {
    server.kill('SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(1));

let passed = 0;
let failed = 0;
const check = (ok, label, detail) => {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

console.log('\nIDOL AI package verification\n');

if (!(await waitForServer())) {
  console.error('The server did not start. Output:\n');
  console.error(log);
  process.exit(1);
}

const health = await (await fetch(`${base}/api/health`)).json();
check(health.ok === true, 'Server responds', `version ${health.version}`);

const status = await (await fetch(`${base}/api/status`)).json();
check(status.knowledge.totalPassages > 0, 'Knowledge index built',
  `${status.knowledge.totalFiles} files / ${status.knowledge.totalPassages} passages`);
check(status.inference.mode === 'knowledge' || status.inference.mode === 'inference',
  'Inference mode is explicit', status.inference.mode);

const shell = await fetch(`${base}/`);
const html = await shell.text();
check(shell.ok && html.includes('id="app"'), 'UI is served');
const asset = /src="(\/assets\/index-[^"]+\.js)"/.exec(html);
if (asset) {
  const js = await fetch(`${base}${asset[1]}`);
  check(js.ok, 'Bundled JavaScript loads', asset[1]);
}

const search = await (await fetch(`${base}/api/search?q=install`)).json();
check(search.hits.length > 0, 'Repository search works', `${search.hits.length} hits`);

// Ask a real question and check the answer is cited.
const response = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'What is this project about?', history: [] }),
});
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let answer = null;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index = buffer.indexOf('\n\n');
  while (index !== -1) {
    const frame = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    index = buffer.indexOf('\n\n');
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const event = JSON.parse(line.slice(5).trim());
        if (event.type === 'done') answer = event.answer;
      } catch {
        /* ignore */
      }
    }
  }
}
check(Boolean(answer), 'Chat answers a question');
if (answer) {
  const ids = new Set(answer.sources.map((source) => source.id));
  const markers = [...answer.text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
  check(answer.sources.length > 0, 'Answer cites sources', `${answer.sources.length} source(s)`);
  check(markers.every((marker) => ids.has(marker)), 'Every citation is real',
    markers.length > 0 ? `${markers.length} marker(s) verified` : 'no markers');
}

const headers = (await fetch(`${base}/api/health`)).headers;
check((headers.get('content-security-policy') ?? '').includes("frame-ancestors 'none'"), 'Security headers set');

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed > 0) {
  console.error('Something is wrong with this package. See docs/LIMITATIONS.md.\n');
  process.exit(1);
}
console.log('Package verified. Start it with:  node start.mjs\n');
process.exit(0);
