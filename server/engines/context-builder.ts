/**
 * Context Builder Engine.
 *
 * Turns ranked passages into a bounded, citation-numbered context block.
 * Every snippet keeps its [n] marker so the generation layer (knowledge mode
 * or an external model) can reference exactly the text that was retrieved.
 */
import type { ChunkKind, SourceRef } from '../../shared/types.js';
import type { Passage } from '../knowledge/indexer.js';
import { truncate } from '../util/common.js';

export interface ContextSnippet {
  id: number;
  sourceId: string;
  sourceName: string;
  path: string;
  heading: string | null;
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  language: string;
  score: number;
  text: string;
  htmlUrl: string | null;
}

export interface BuiltContext {
  snippets: ContextSnippet[];
  sources: SourceRef[];
  text: string;
  chars: number;
  truncated: boolean;
  /** Paths by number for citation validation. */
  byId: Map<number, ContextSnippet>;
}

export interface BuildContextInput {
  hits: Array<{
    passage: Passage;
    score: number;
    sourceName?: string;
    htmlUrl?: string | null;
  }>;
  maxChars: number;
  maxSnippets: number;
  /** Maximum snippets taken from one file. */
  maxPerFile: number;
  /** Minimum score, relative to the best hit, for a passage to be included. */
  minRelativeScore?: number;
}

const MIN_SNIPPET_CHARS = 160;

export function buildContext(input: BuildContextInput): BuiltContext {
  const best = input.hits[0]?.score ?? 0;
  const threshold = input.minRelativeScore !== undefined ? best * input.minRelativeScore : 0;
  const snippets: ContextSnippet[] = [];
  const seenPassages = new Set<string>();
  const perFile = new Map<string, number>();
  let used = 0;
  let truncated = false;

  for (const hit of input.hits) {
    // Never show the same passage twice, and cap how many snippets come from a
    // single file so one long README cannot crowd out other sources.
    const passageKey = `${hit.passage.sourceId}:${hit.passage.path}:${hit.passage.startLine}`;
    if (seenPassages.has(passageKey)) continue;
    const fileKey = hit.passage.path;
    if ((perFile.get(fileKey) ?? 0) >= input.maxPerFile) continue;
    if (snippets.length >= input.maxSnippets) {
      truncated = true;
      break;
    }
    if (threshold > 0 && hit.score < threshold) break;
    const header = `${hit.passage.path}${hit.passage.heading ? ` › ${hit.passage.heading}` : ''} (lines ${hit.passage.startLine}-${hit.passage.endLine})`;
    const remaining = input.maxChars - used;
    if (remaining < MIN_SNIPPET_CHARS) {
      truncated = true;
      break;
    }
    const availableForText = remaining - header.length - 24;
    const text = hit.passage.text.length > availableForText ? truncate(hit.passage.text, Math.max(80, availableForText)) : hit.passage.text;
    seenPassages.add(passageKey);
    perFile.set(fileKey, (perFile.get(fileKey) ?? 0) + 1);
    const id = snippets.length + 1;
    const sourceName = hit.sourceName ?? hit.passage.sourceId;
    snippets.push({
      id,
      sourceId: hit.passage.sourceId,
      sourceName,
      path: hit.passage.path,
      heading: hit.passage.heading,
      startLine: hit.passage.startLine,
      endLine: hit.passage.endLine,
      kind: hit.passage.kind,
      language: hit.passage.language,
      score: hit.score,
      text,
      htmlUrl: hit.htmlUrl ?? null,
    });
    used += text.length + header.length + 24;
    if (text.length < hit.passage.text.length) truncated = true;
  }

  const text = snippets
    .map(
      (snippet) =>
        `[${snippet.id}] ${snippet.path}${snippet.heading ? ` › ${snippet.heading}` : ''} (lines ${snippet.startLine}-${snippet.endLine}, score ${snippet.score.toFixed(2)})\n${snippet.text}`,
    )
    .join('\n\n---\n\n');

  const sources: SourceRef[] = snippets.map((snippet) => ({
    id: snippet.id,
    sourceId: snippet.sourceId,
    sourceName: snippet.sourceName,
    path: snippet.path,
    heading: snippet.heading,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    language: snippet.language,
    score: Number(snippet.score.toFixed(3)),
    htmlUrl: snippet.htmlUrl,
    excerpt: makeCitationExcerpt(snippet.text),
    kind: snippet.kind,
  }));

  return {
    snippets,
    sources,
    text,
    chars: text.length,
    truncated,
    byId: new Map(snippets.map((snippet) => [snippet.id, snippet])),
  };
}

function makeCitationExcerpt(text: string, maxChars = 260): string {
  const cleaned = text.replace(/\s+\n/g, '\n').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`;
}
