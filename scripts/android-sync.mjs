#!/usr/bin/env node
/**
 * Copies the offline web bundle into the Android project as assets.
 *
 *   npm run android:sync   → android/app/src/main/assets/www/
 *
 * The APK is a WebView shell, so the app *is* this folder. Keeping the copy
 * explicit rather than pointing Gradle at dist-device means the Android build
 * never reads from a directory that may hold an unrelated build.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist-device');
const target = path.join(root, 'android/app/src/main/assets/www');

if (!existsSync(path.join(source, 'index.html'))) {
  console.error('\n  dist-device/index.html is missing. Run: npm run build:device\n');
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });

// A service worker has nothing to do inside an APK: the assets are already local,
// and registering one would only add a cache layer over a local file.
const serviceWorker = path.join(target, 'sw.js');
if (existsSync(serviceWorker)) rmSync(serviceWorker);

const copied = files(target);
const bytes = copied.reduce((sum, file) => sum + statSync(file).size, 0);

// The app bundle must be exactly one file. And no fetch layer anywhere: a single
// surviving /api/ reference means the APK would ship code that can only fail.
// theme-boot.js sets the theme before first paint and is not part of the app
// bundle; the bundle lives in assets/.
const bundleChunks = copied.filter(
  (file) => file.endsWith('.js') && file.includes(`${path.sep}www${path.sep}assets${path.sep}`),
);
if (bundleChunks.length !== 1) {
  console.error(`  ${bundleChunks.length} bundle files copied; the device build must emit exactly one.`);
  process.exit(1);
}
const bundle = readFileSync(bundleChunks[0], 'utf8');
if (bundle.includes('/api/')) {
  console.error('  The bundle still references /api/. The offline build must not call a server.');
  process.exit(1);
}

console.log(`\n  Synced ${copied.length} file(s), ${(bytes / 1024).toFixed(0)} kB → android/app/src/main/assets/www\n`);
