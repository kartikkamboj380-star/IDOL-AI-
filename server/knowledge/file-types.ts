/**
 * File classification and parsing helpers for the knowledge index.
 *
 * The parser converts every supported file into a normalised list of text
 * segments (heading + lines) which downstream chunking turns into passages.
 * Binary, LFS-pointer, and oversized files are rejected with a reason so the
 * UI can explain what was skipped instead of silently ignoring it.
 */
import type { ChunkKind } from '../../shared/types.js';

export type FileFamily = 'markdown' | 'code' | 'data' | 'text' | 'notebook' | 'unsupported';

export const MAX_TEXT_BYTES = 400_000;

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.sql': 'sql',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.xml': 'xml',
  '.svg': 'xml',
  '.ipynb': 'json',
  '.txt': 'text',
  '.csv': 'csv',
  '.env': 'bash',
  '.dockerfile': 'dockerfile',
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.editorconfig': 'text',
  '.cfg': 'ini',
  '.ini': 'ini',
  '.lock': 'text',
};

const SPECIAL_NAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  procfile: 'text',
  'readme': 'markdown',
  license: 'text',
  notice: 'text',
  '.gitignore': 'text',
  '.gitattributes': 'text',
  '.dockerignore': 'text',
  '.editorconfig': 'text',
  '.env.example': 'bash',
};

const CODE_EXTENSIONS = new Set(
  Object.entries(LANGUAGE_BY_EXT)
    .filter(([, lang]) =>
      ['typescript', 'tsx', 'javascript', 'jsx', 'python', 'ruby', 'go', 'rust', 'java', 'kotlin', 'swift', 'c', 'cpp', 'csharp', 'php', 'bash', 'powershell', 'sql', 'html', 'css', 'scss', 'dockerfile', 'makefile'].includes(lang),
    )
    .map(([ext]) => ext),
);

/** Files that are never useful knowledge (large binaries, media, lock noise). */
const HARD_SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff', '.psd',
  '.mp4', '.mov', '.webm', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.tar',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.jar', '.pyc',
  '.safetensors', '.ckpt', '.pt', '.pth', '.onnx', '.gguf', '.h5', '.pkl', '.npy', '.npz', '.parquet', '.arrow',
  '.wasm', '.map', '.min.js', '.min.css',
]);

const SKIP_FILENAMES = new Set(['.DS_Store', 'Thumbs.db']);

export function extensionOf(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot);
}

export function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] ?? path;
}

export function languageFor(path: string): string {
  const name = basename(path).toLowerCase();
  if (SPECIAL_NAMES[name]) return SPECIAL_NAMES[name] as string;
  for (const [special, lang] of Object.entries(SPECIAL_NAMES)) {
    if (name.startsWith(`${special}.`)) return lang;
  }
  const ext = extensionOf(path);
  return LANGUAGE_BY_EXT[ext] ?? 'text';
}

export function fileFamily(path: string): FileFamily {
  const name = basename(path).toLowerCase();
  const ext = extensionOf(path);
  if (ext === '.ipynb') return 'notebook';
  if (ext === '.md' || ext === '.mdx' || ext === '.markdown' || name.startsWith('readme')) return 'markdown';
  if (ext === '.json' || ext === '.jsonc' || ext === '.yml' || ext === '.yaml' || ext === '.toml' || ext === '.csv' || ext === '.ini' || ext === '.cfg') return 'data';
  if (CODE_EXTENSIONS.has(ext) || SPECIAL_NAMES[name] === 'dockerfile' || SPECIAL_NAMES[name] === 'makefile') return 'code';
  if (ext === '.txt' || SPECIAL_NAMES[name] || ext === '.lock') return 'text';
  if (HARD_SKIP_EXTENSIONS.has(ext)) return 'unsupported';
  return 'unsupported';
}

export interface ParseRejection {
  ok: false;
  reason: 'binary' | 'too_large' | 'unsupported_type' | 'lfs_pointer' | 'empty' | 'generated';
  detail: string;
}

export interface ParsedFile {
  ok: true;
  path: string;
  language: string;
  family: FileFamily;
  kind: ChunkKind;
  /** Original text with normalised newlines, capped. */
  text: string;
  /** Number of lines in `text`. */
  lineCount: number;
  truncated: boolean;
  /** Title derived from the first heading or the file name. */
  title: string;
}

export type ParseResult = ParsedFile | ParseRejection;

const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1';

export function looksLikeLfsPointer(text: string): boolean {
  return text.startsWith(LFS_HEADER) && text.includes('\noid sha256:') && /\nsize \d+\n?/.test(text);
}

function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(1, sample.length) > 0.02;
}

export function isGeneratedFile(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes('node_modules/') ||
    lower.startsWith('dist/') ||
    lower.startsWith('build/') ||
    lower.startsWith('vendor/') ||
    lower.endsWith('.min.js') ||
    lower.endsWith('.min.css') ||
    lower.includes('package-lock.json') ||
    lower.includes('pnpm-lock.yaml') ||
    lower.includes('yarn.lock')
  );
}

/** Extracts a short title for a markdown or code file. */
function deriveTitle(path: string, family: FileFamily, text: string): string {
  if (family === 'markdown') {
    const headings = parseMarkdownSegments(text);
    const first = headings.find((segment) => segment.heading && segment.heading.length > 0);
    if (first?.heading) return first.heading;
  }
  return basename(path);
}

export interface TextSegment {
  heading: string | null;
  startLine: number;
  endLine: number;
  text: string;
  level?: number;
}

/**
 * Splits markdown into heading-delimited segments. Front matter is kept as a
 * "Front matter" segment, fenced code blocks are preserved inside their parent
 * section (they matter for install commands and examples).
 */
export function parseMarkdownSegments(text: string): TextSegment[] {
  const lines = text.split('\n');
  const segments: TextSegment[] = [];

  // Skip YAML front matter: it is site metadata, never an answer.
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end > 0 && end < 40) start = end + 1;
  }

  interface Section {
    heading: string | null;
    level: number;
    startLine: number;
    lines: string[];
  }

  const sections: Section[] = [];
  let current: Section = { heading: null, level: 0, startLine: start + 1, lines: [] };
  let inFence = false;

  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const headingMatch = !inFence ? /^(#{1,6})\s+(.*\S)\s*$/.exec(line) : null;
    if (headingMatch) {
      // Flush the previous section before starting a new one.
      sections.push(current);
      const level = (headingMatch[1] ?? '#').length;
      const title = (headingMatch[2] ?? '').replace(/#+\s*$/, '').trim();
      current = { heading: title, level, startLine: index + 1, lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);

  for (const section of sections) {
    // Trim blank lines at both ends while preserving absolute line numbers.
    let first = 0;
    while (first < section.lines.length && (section.lines[first] ?? '').trim() === '') first += 1;
    let last = section.lines.length - 1;
    while (last >= first && (section.lines[last] ?? '').trim() === '') last -= 1;
    if (last < first) continue;
    const body = section.lines.slice(first, last + 1).join('\n');
    if (body.trim().length === 0) continue;
    segments.push({
      heading: section.heading,
      startLine: section.startLine + first,
      endLine: section.startLine + last,
      text: body,
      level: section.level,
    });
  }

  return segments;
}

/** Splits a file into line-oriented segments (whole file for small files). */
export function parseCodeSegments(text: string, path: string): TextSegment[] {
  const lines = text.split('\n');
  const segments: TextSegment[] = [];
  const chunkSize = 80;
  const overlap = 10;
  if (lines.length <= chunkSize) {
    return [{ heading: basename(path), startLine: 1, endLine: lines.length, text, level: 1 }];
  }
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(lines.length, start + chunkSize);
    segments.push({
      heading: basename(path),
      startLine: start + 1,
      endLine: end,
      text: lines.slice(start, end).join('\n'),
      level: 1,
    });
    if (end >= lines.length) break;
    start = end - overlap;
  }
  return segments;
}

export function parseNotebook(text: string, path: string): string | null {
  try {
    const notebook = JSON.parse(text) as { cells?: Array<{ cell_type?: string; source?: string[] | string }> };
    const cells = notebook.cells ?? [];
    const parts: string[] = [`# Notebook: ${basename(path)}`];
    let emitted = 0;
    for (const [index, cell] of cells.entries()) {
      const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '');
      if (!source.trim()) continue;
      const heading = cell.cell_type === 'markdown' ? 'Markdown' : `Cell ${index + 1}`;
      parts.push(`## ${heading}\n${source.trim()}`);
      emitted += 1;
      if (emitted >= 120) break;
    }
    return parts.join('\n\n');
  } catch {
    return null;
  }
}

export function parseFile(path: string, content: string | Buffer, maxBytes = MAX_TEXT_BYTES): ParseResult {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (buffer.length === 0) return { ok: false, reason: 'empty', detail: `${path} is empty` };

  // LFS pointers and binary payloads are checked first: a model weight file has
  // an "unsupported" extension, but the honest reason is that only a pointer
  // (or binary blob) was retrieved — the UI must say so rather than imply the
  // model itself was read.
  const headText = buffer.subarray(0, Math.min(buffer.length, 1024)).toString('utf8');
  if (looksLikeLfsPointer(headText)) {
    return { ok: false, reason: 'lfs_pointer', detail: `${path} is a Git LFS pointer, not readable text` };
  }
  const family = fileFamily(path);
  if (family === 'unsupported') {
    return { ok: false, reason: 'unsupported_type', detail: `Unsupported file type for ${path}` };
  }
  if (isProbablyBinary(buffer)) {
    return { ok: false, reason: 'binary', detail: `${path} contains binary data` };
  }
  let text = buffer.toString('utf8').replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  let truncated = false;
  if (buffer.length > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak > maxBytes * 0.5) text = text.slice(0, lastBreak);
  }

  if (family === 'notebook') {
    const parsed = parseNotebook(text, path);
    if (parsed === null) {
      return { ok: false, reason: 'unsupported_type', detail: `${path} is not a readable notebook` };
    }
    text = parsed;
  }

  if (text.trim().length === 0) return { ok: false, reason: 'empty', detail: `${path} has no extractable text` };

  const kind: ChunkKind =
    family === 'markdown' ? 'markdown' : family === 'code' ? 'code' : family === 'data' ? 'data' : 'text';

  return {
    ok: true,
    path,
    language: languageFor(path),
    family,
    kind,
    text,
    lineCount: text.split('\n').length,
    truncated,
    title: deriveTitle(path, family, text),
  };
}
