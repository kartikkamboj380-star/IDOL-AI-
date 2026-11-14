/**
 * Bakes the demo corpus into the device bundle.
 *
 * The offline app has no network and starts empty, which makes for a bad first
 * run: nothing to search, nothing to prove it works. Rather than ship a second
 * copy of the sample files inside the APK and read them at runtime, the text is
 * inlined here as a generated module. It is a few tens of kilobytes, it cannot be
 * missing, and the device build stays a single folder of assets.
 *
 *   npx tsx scripts/build-sample.ts
 *
 * Run by `npm run build:device`; the output is committed so a plain `npm run
 * build` also has it.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(ROOT, 'huggingface');
const OUT = path.join(ROOT, 'web/src/lib/sample-corpus.ts');

const TEXT = ['.md', '.markdown', '.txt', '.json', '.yml', '.yaml', '.toml', '.gitattributes'];
const MAX_BYTES = 120_000;

async function walk(dir: string, prefix = ''): Promise<Array<{ path: string; text: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; text: string }> = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolute, relative)));
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (!TEXT.some((extension) => lower.endsWith(extension)) && lower !== '.gitattributes') continue;
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_BYTES) continue;
    files.push({ path: relative, text: await fs.readFile(absolute, 'utf8') });
  }

  return files;
}

const docs = await walk(SOURCE);
if (docs.length === 0) {
  throw new Error(`No text files found under ${SOURCE}`);
}

const bytes = docs.reduce((sum, doc) => sum + doc.text.length, 0);

const header = `/**
 * GENERATED FILE — do not edit.
 *
 * Produced by scripts/build-sample.ts from huggingface/ so the offline app has
 * something to answer about on first run. Regenerate with:
 *
 *   npx tsx scripts/build-sample.ts
 *
 * ${docs.length} file(s), ${(bytes / 1024).toFixed(1)} kB of text.
 */
export interface SampleDoc {
  path: string;
  text: string;
}

export const SAMPLE_NAME = 'Sample: IDOL 3D reconstruction';

export const SAMPLE_DOCS: SampleDoc[] = [
`;

const body = docs
  .map((doc) => `  {\n    path: ${JSON.stringify(doc.path)},\n    text: ${JSON.stringify(doc.text)},\n  },`)
  .join('\n');

await fs.writeFile(OUT, `${header}${body}\n];\n`, 'utf8');
console.log(`Wrote ${path.relative(ROOT, OUT)} — ${docs.length} file(s), ${(bytes / 1024).toFixed(1)} kB`);
