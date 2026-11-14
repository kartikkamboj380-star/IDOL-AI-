#!/usr/bin/env node
/**
 * Builds the offline bundle that ships inside the Android app.
 *
 *   npm run build:device   → dist-device/
 *
 * Differs from `npm run build` in three ways, all of them about being a phone
 * with no server and a slow filesystem:
 *
 *   - the app answers from an on-page index instead of fetch('/api/*'), selected
 *     at build time by __IDOL_DEVICE__ so it can never pick the wrong brain;
 *   - everything is one JS file and one CSS file, because a WebView opening
 *     forty small chunks from the asset bundle is slower than reading 325 kB;
 *   - the sample corpus is inlined, so first run has something to answer about.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, IDOL_DEVICE_BUILD: '1' } });

console.log('\nBuilding the offline device bundle\n');

console.log('  inlining the sample corpus…');
execFileSync('npx', ['tsx', 'scripts/build-sample.ts'], { cwd: root, stdio: 'inherit' });

console.log('  typechecking…');
run('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit']);

console.log('  bundling…');
rmSync(path.join(root, 'dist-device'), { recursive: true, force: true });
run('npx', ['vite', 'build']);

console.log('\n  Done: dist-device/ — one JS file, one CSS file, no network.\n');
