/**
 * Chunking + inverted-index construction.
 *
 * A "passage" is the retrieval unit. Markdown becomes heading-scoped passages
 * with fenced code blocks kept inline; code files become overlapping windows;
 * data files become whole-file passages. Every passage keeps exact line ranges
 * so citations can show verbatim source text.
 */
import { sha1Hex } from '../../shared/crypto.js';
import type { ChunkKind } from '../../shared/types.js';
import { contentTerms, tokenize } from './text.js';
import type { ParsedFile } from './file-types.js';
import { parseCodeSegments, parseMarkdownSegments } from './file-types.js';

export interface Passage {
  id: string;
  sourceId: string;
  path: string;
  heading: string | null;
  headingPath: string[];
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  language: string;
  text: string;
  /** Topped-up text used for BM25 (includes heading + path for context). */
  searchText: string;
  termCounts: Record<string, number>;
  length: number;
  hasCode: boolean;
  /** Document-quality prior: README/docs > prose > code > CI/config noise. */
  docWeight: number;
}

export interface SourceIndexFile {
  path: string;
  size: number;
  sha: string | null;
  language: string;
  kind: ChunkKind;
  lineCount: number;
  passageIds: string[];
  title: string;
  truncated: boolean;
  htmlUrl: string | null;
}

export interface Posting {
  /** passage ordinal within the source */
  p: number;
  /** term frequency */
  t: number;
  /** field boost: heading/excerpt matches score higher */
  f: number;
}

export interface SourceIndex {
  sourceId: string;
  builtAt: string;
  ref: string;
  resolvedRef: string;
  files: SourceIndexFile[];
  passages: Passage[];
  postings: Record<string, Posting[]>;
  /** Document frequencies, used for IDF. */
  docFreq: Record<string, number>;
  avgLength: number;
  totalLength: number;
  stats: {
    filesIndexed: number;
    passages: number;
    bytes: number;
    skipped: number;
    truncatedTree: boolean;
    truncatedFiles: number;
  };
}

/**
 * Structural prior: how much a file is "documentation" rather than implementation.
 * Documentation answers most questions, so the gap is deliberately large.
 */
export function documentWeight(filePath: string): number {
  const lower = filePath.toLowerCase();
  const name = lower.split('/').pop() ?? lower;
  if (/^\.github\//.test(lower)) return 0.55; // CI config is rarely the answer
  if (name.startsWith('readme')) return 1.6;
  if (lower.startsWith('docs/') || lower.includes('/docs/') || lower.includes('/documentation/')) return 1.45;
  if (name.endsWith('.md') || name.endsWith('.mdx')) return 1.25;
  if (name.endsWith('.txt') || name.endsWith('.rst') || name.endsWith('.adoc')) return 1.1;
  if (name === 'package.json' || name.endsWith('.toml')) return 0.95;
  if (name.endsWith('.json')) return 0.7;
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 0.8;
  if (name.endsWith('.ipynb')) return 0.68;
  if (/^(license|notice|code_of_conduct|contributing)/.test(name)) return 0.9;
  // Implementation code: relevant for code questions, but it must not
  // outrank prose when the user asks a documentation question.
  return 0.62;
}

const MAX_PASSAGE_CHARS = 1800;
const MIN_PASSAGE_CHARS = 24;
const WINDOW = 44;
const OVERLAP = 8;

function passageId(sourceId: string, path: string, index: number): string {
  return sha1Hex(`${sourceId}:${path}:${index}`).slice(0, 16);
}

/** Splits long markdown sections on paragraph boundaries. */
function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let current = '';
  for (const paragraph of paragraphs) {
    if (current.length > 0 && current.length + paragraph.length + 2 > maxChars) {
      parts.push(current);
      current = '';
    }
    if (paragraph.length > maxChars) {
      if (current) {
        parts.push(current);
        current = '';
      }
      const lines = paragraph.split('\n');
      let block = '';
      for (const line of lines) {
        if (block.length + line.length + 1 > maxChars && block.length > 0) {
          parts.push(block);
          block = '';
        }
        if (line.length > maxChars) {
          for (let i = 0; i < line.length; i += maxChars) parts.push(line.slice(i, i + maxChars));
          continue;
        }
        block = block ? `${block}\n${line}` : line;
      }
      if (block) parts.push(block);
      continue;
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) parts.push(current);
  return parts.slice(0, 40);
}

export interface BuildChunksOptions {
  maxChunks: number;
}

export function buildPassages(
  sourceId: string,
  file: ParsedFile,
  htmlUrl: string | null,
  options: BuildChunksOptions,
): Passage[] {
  const passages: Passage[] = [];
  const push = (input: {
    heading: string | null;
    headingPath: string[];
    startLine: number;
    endLine: number;
    text: string;
  }): void => {
    if (passages.length >= options.maxChunks) return;
    const trimmed = input.text.trim();
    if (trimmed.length < MIN_PASSAGE_CHARS) return;
    // A passage that is only a heading contains no evidence.
    const withoutHeading = trimmed.replace(/^#{1,6}\s+.*$/gm, '').trim();
    if (withoutHeading.length < 12) return;
    const hasCode = /```|\b(function|class|const|let|var|def|import|export|return|await|async)\b/.test(trimmed);
    const searchText = [input.headingPath.join(' '), file.path, trimmed].filter(Boolean).join('\n');
    const { counts } = contentTerms(searchText);
    const terms: Record<string, number> = {};
    let length = 0;
    for (const [term, count] of counts) {
      terms[term] = count;
      length += count;
    }
    if (length === 0) return;
    passages.push({
      id: passageId(sourceId, file.path, passages.length),
      sourceId,
      path: file.path,
      heading: input.heading,
      headingPath: input.headingPath,
      startLine: input.startLine,
      endLine: input.endLine,
      kind: file.kind,
      language: file.language,
      text: trimmed,
      searchText,
      termCounts: terms,
      length,
      hasCode,
      docWeight: documentWeight(file.path),
    });
  };

  if (file.family === 'markdown') {
    const segments = parseMarkdownSegments(file.text);
    const stack: Array<{ level: number; heading: string }> = [];
    for (const segment of segments) {
      if (segment.heading) {
        const level = segment.level ?? 1;
        while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) stack.pop();
        stack.push({ level, heading: segment.heading });
      }
      const headingPath = stack.map((entry) => entry.heading);
      for (const piece of splitLongText(segment.text, MAX_PASSAGE_CHARS)) {
        push({
          heading: segment.heading,
          headingPath,
          startLine: segment.startLine,
          endLine: segment.endLine,
          text: piece,
        });
      }
    }
    return passages;
  }

  if (file.family === 'code') {
    const segments = parseCodeSegments(file.text, file.path);
    for (const segment of segments) {
      push({
        heading: segment.heading,
        headingPath: [file.path],
        startLine: segment.startLine,
        endLine: segment.endLine,
        text: segment.text,
      });
    }
    // Large code files get tighter windows so a citation is not a wall of code.
    if (passages.length === 1 && file.lineCount > WINDOW) {
      passages.length = 0;
      const lines = file.text.split('\n');
      let start = 0;
      while (start < lines.length && passages.length < options.maxChunks) {
        const end = Math.min(lines.length, start + WINDOW);
        push({
          heading: file.path.split('/').pop() ?? file.path,
          headingPath: [file.path],
          startLine: start + 1,
          endLine: end,
          text: lines.slice(start, end).join('\n'),
        });
        if (end >= lines.length) break;
        start = end - OVERLAP;
      }
    }
    return passages;
  }

  // data / text: split by size, keeping each passage self-describing.
  for (const piece of splitLongText(file.text, MAX_PASSAGE_CHARS)) {
    push({
      heading: file.title,
      headingPath: [file.path],
      startLine: 1,
      endLine: Math.min(file.lineCount, piece.split('\n').length),
      text: piece,
    });
  }
  return passages;
}

/** Builds the inverted index and document-frequency table for a source. */
export function buildInvertedIndex(
  sourceId: string,
  files: SourceIndexFile[],
  passages: Passage[],
): Pick<SourceIndex, 'postings' | 'docFreq' | 'avgLength' | 'totalLength'> {
  const postings: Record<string, Posting[]> = Object.create(null) as Record<string, Posting[]>;
  const docFreq: Record<string, number> = Object.create(null) as Record<string, number>;
  let totalLength = 0;
  const pathByPassage = new Map<string, number>();
  passages.forEach((passage, index) => pathByPassage.set(passage.id, index));

  // path -> file-level boost terms; used to rank passages from files whose own
  // path/name matches the query even when the body does not repeat it.
  const fileByPath = new Map(files.map((file) => [file.path, file]));

  const headingTerms = new Map<number, Set<string>>();
  const pathTerms = new Map<number, Set<string>>();

  for (const [fileIndex, file] of files.entries()) {
    const filePathTerms = new Set(contentTerms(file.path.replace(/[\/._-]/g, ' ')).terms);
    for (const passageIdValue of file.passageIds) {
      const index = pathByPassage.get(passageIdValue);
      if (index === undefined) continue;
      pathTerms.set(index, filePathTerms);
      const passage = passages[index] as Passage;
      const headingSet = new Set(contentTerms(`${passage.headingPath.join(' ')} ${passage.heading ?? ''}`).terms);
      headingTerms.set(index, headingSet);
    }
    void fileIndex;
  }

  passages.forEach((passage, index) => {
    totalLength += passage.length;
    for (const [term, count] of Object.entries(passage.termCounts)) {
      const fieldBoost =
        (headingTerms.get(index)?.has(term) ? 1.6 : 0) + (pathTerms.get(index)?.has(term) ? 0.6 : 0);
      const posting: Posting = { p: index, t: count, f: fieldBoost };
      (postings[term] ??= []).push(posting);
      docFreq[term] = (docFreq[term] ?? 0) + 1;
    }
  });

  // Sort postings so retrieval can early-exit on low-idf terms if ever needed.
  for (const term of Object.keys(postings)) {
    (postings[term] as Posting[]).sort((a, b) => a.p - b.p);
  }

  void sourceId;
  void fileByPath;
  return {
    postings,
    docFreq,
    totalLength,
    avgLength: passages.length > 0 ? totalLength / passages.length : 0,
  };
}

export function estimateLength(text: string): number {
  return tokenize(text).length;
}
