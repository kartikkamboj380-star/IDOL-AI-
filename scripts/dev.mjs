#!/usr/bin/env node
/**
 * Development runner: starts the API server (tsx watch) and the Vite dev server
 * together, forwards their output with prefixes, and shuts both down cleanly.
 *
 * Vite proxies /api to the API server, so the browser only ever talks to one
 * origin (the preview host) — no CORS, no absolute URLs in client code.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = process.env.PORT ?? '8787';

const children = [];
let shuttingDown = false;

function run(name, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}]`;
  const pipe = (stream, target) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        target.write(`${prefix} ${line}\n`);
        index = buffer.indexOf('\n');
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix} exited (${signal ?? code}). Shutting down.\n`);
    shutdown(code ?? 1);
  });

  children.push({ name, child });
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 3000).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', process.execPath, ['--import', 'tsx', 'server/index.ts'], { PORT: API_PORT });
run('web', process.execPath, ['node_modules/vite/bin/vite.js'], { IDOL_API_URL: `http://127.0.0.1:${API_PORT}` });
