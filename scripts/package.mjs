#!/usr/bin/env node
/**
 * Builds a self-contained, downloadable distribution package.
 *
 *   node scripts/package.mjs            → dist-package/idol-ai-<version>.tar.gz + .zip
 *
 * The result runs offline on any machine with Node 20.11+:
 *
 *   tar -xzf idol-ai-<version>.tar.gz && cd idol-ai-<version> && node start.mjs
 *
 * Everything the runtime needs is inside: the built UI, the compiled server,
 * production node_modules, the demo corpus, docs, and a launcher. No build step
 * and no network access are required on the receiving machine.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version ?? '0.0.0';
const name = `idol-ai-${version}`;
const outDir = path.join(root, 'dist-package');
const stage = path.join(outDir, name);

const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });

console.log(`\nPackaging ${name}\n`);

/* 1 — Build everything from source ---------------------------------- */
console.log('  building UI and server…');
run('npm', ['run', 'typecheck']);
run('npm', ['run', 'build']);
run('npm', ['run', 'build:server']);

/* 2 — Stage a clean tree ------------------------------------------- */
console.log('  staging files…');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const copy = (entry) => {
  const from = path.join(root, entry);
  if (!existsSync(from)) {
    console.warn(`    skipped (missing): ${entry}`);
    return;
  }
  cpSync(from, path.join(stage, entry), { recursive: true });
};

for (const entry of ['dist', 'dist-server', 'data', 'huggingface', 'docs']) copy(entry);
for (const entry of ['README.md', 'LICENSE', 'package.json', 'package-lock.json']) copy(entry);

/* 3 — Trim the manifest to runtime-only ---------------------------- */
const manifest = {
  ...pkg,
  scripts: {
    start: 'node --enable-source-maps dist-server/server/index.js',
    verify: 'node scripts/verify.mjs',
  },
};
delete manifest.devDependencies;
writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(stage, '.env.example'), readFileSync(path.join(root, '.env.example'), 'utf8'));

/* 4 — Install production dependencies into the package ------------- */
console.log('  installing runtime dependencies…');
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

/* 5 — Launcher, verifier, and a plain-language readme -------------- */
for (const file of ['start.mjs', path.join('scripts', 'verify.mjs')]) {
  const source = path.join(root, 'packaging', file);
  if (!existsSync(source)) {
    throw new Error(`Missing packaging asset: ${source}`);
  }
  const target = path.join(stage, file);
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target);
}
cpSync(path.join(root, 'packaging', 'PACKAGE-README.md'), path.join(stage, 'README.md'));
cpSync(path.join(root, 'packaging', 'TERMUX.md'), path.join(stage, 'TERMUX.md'));

/* 6 — Remove runtime leftovers from the staged tree ---------------- */
rmSync(path.join(stage, '.data'), { recursive: true, force: true });
rmSync(path.join(stage, '.data-verify'), { recursive: true, force: true });

/* 7 — Archive ------------------------------------------------------ */
console.log('  creating archives…');
run('tar', ['-czf', path.join(outDir, `${name}.tar.gz`), name], outDir);
try {
  run('zip', ['-qr', path.join(outDir, `${name}.zip`), name], outDir);
} catch {
  // `zip` is not present everywhere; fall back to Python's zipfile.
  run('python3', ['-c', `import shutil; shutil.make_archive(${JSON.stringify(path.join(outDir, name))}, 'zip', ${JSON.stringify(outDir)}, ${JSON.stringify(name)})`]);
}

const size = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;
console.log(`
  Done:
    ${path.relative(root, path.join(outDir, `${name}.tar.gz`))}  (${size(path.join(outDir, `${name}.tar.gz`))})
    ${path.relative(root, path.join(outDir, `${name}.zip`))}  (${size(path.join(outDir, `${name}.zip`))})

  The package runs offline: tar -xzf ${name}.tar.gz && cd ${name} && node start.mjs
`);
