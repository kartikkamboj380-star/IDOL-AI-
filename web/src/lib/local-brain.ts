/**
 * The whole answer path, in the browser.
 *
 * The desktop build runs a Node process: the Express API wraps a knowledge
 * service that indexes GitHub trees and caches indexes on disk. On a phone there
 * is no process to run and no server to call, so the same two engines are wired
 * up here instead, against documents that live in IndexedDB.
 *
 *   documents ──▶ SourceIndex ──▶ KnowledgeEngine.gather() ──▶ AnswerEngine.write()
 *                (parsing,        (search + evidence            (composition +
 *                 BM25, passages)  verdict)                     citation checks)
 *
 * The engines themselves are the production ones — the same files the server
 * imports. That is deliberate: a browser build with its own simplified search
 * would drift from the desktop app and neither would be trustworthy. What is
 * reimplemented here is only the plumbing the server used to provide.
 *
 * Everything is local. No request leaves the device.
 */
import { parseFile } from '../../../server/knowledge/file-types.js';
import { buildInvertedIndex, buildPassages, type SourceIndex, type SourceIndexFile } from '../../../server/knowledge/indexer.js';
import { Retriever } from '../../../server/knowledge/retriever.js';
import { KnowledgeEngine } from '../../../server/engines/knowledge-engine.js';
import { AnswerEngine } from '../../../server/engines/answer-engine.js';
import { buildMemory } from '../../../server/engines/memory.js';
import { createLogger } from '../../../server/logger.js';
import type { AppConfig } from '../../../server/config.js';
import type { InferenceAdapter } from '../../../server/inference/provider.js';
import type { AnswerPayload, ChunkKind, SourceRef, StreamEvent } from '../../../shared/types.js';

/** One document the user has loaded into the app. */
export interface LocalDoc {
  /** Path inside the source, e.g. `README.md` or `docs/guide.md`. */
  path: string;
  text: string;
}

export interface LocalSource {
  id: string;
  name: string;
  docs: LocalDoc[];
}

const MAX_FILES = 400;
const MAX_FILE_BYTES = 400_000;

/**
 * Browser-side stand-in for the server config. Only the fields the engines read
 * are meaningful; anything about ports, TLS or disk is inert here.
 */
export const LOCAL_CONFIG = {
  version: '1.1.0',
  packageName: 'idol-ai',
  nodeEnv: 'production',
  port: 0,
  host: 'local',
  dataDir: '',
  localDir: null,
  allowLocalFallback: false,
  defaultRepo: null,
  defaultRef: 'main',
  maxFilesPerSource: MAX_FILES,
  maxFileBytes: MAX_FILE_BYTES,
  maxContextChars: 12000,
  maxSourceBytes: 24_000_000,
  maxMessageChars: 4000,
  maxHistoryTurns: 6,
  maxPassagesPerSource: 20_000,
  rateLimitPerMinute: 0,
  webDistDir: '',
  inference: {
    baseUrl: null,
    apiKey: null,
    model: null,
    timeoutMs: 60_000,
    maxTokens: 700,
    temperature: 0.2,
  },
  githubToken: null,
  knowledgeModeOnly: true,
} as unknown as AppConfig;

/** There is no model on a phone: answers are extractive, by design. */
const noInference = {
  status: () => ({
    available: false,
    provider: null,
    model: null,
    reason:
      'This app answers on the device from the documents you loaded. No language model is configured, so every sentence comes from your own files.',
    mode: 'knowledge' as const,
  }),
} as unknown as InferenceAdapter;

/**
 * Parses and indexes one source. Mirrors what `KnowledgeService` does on the
 * server, minus the fs cache: on a phone the whole corpus is a few hundred KB,
 * so rebuilding the index costs milliseconds.
 */
export function indexSource(source: LocalSource): { index: SourceIndex; skipped: Array<{ path: string; reason: string }> } {
  const files: SourceIndexFile[] = [];
  const passages: SourceIndex['passages'] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  const chosen = source.docs.slice(0, MAX_FILES);
  if (source.docs.length > MAX_FILES) {
    skipped.push({ path: '*', reason: `only the first ${MAX_FILES} files were indexed` });
  }

  for (const doc of chosen) {
    if (doc.text.length > MAX_FILE_BYTES) {
      skipped.push({ path: doc.path, reason: `larger than ${Math.round(MAX_FILE_BYTES / 1000)} kB` });
      continue;
    }
    const parsed = parseFile(doc.path, doc.text);
    if (!parsed.ok) {
      skipped.push({ path: doc.path, reason: parsed.reason });
      continue;
    }
    const chunks = buildPassages(source.id, parsed, null, { maxChunks: 100 });
    passages.push(...chunks);
    files.push({
      path: doc.path,
      size: doc.text.length,
      sha: null,
      language: parsed.language,
      kind: parsed.kind,
      lineCount: parsed.lineCount,
      passageIds: chunks.map((passage) => passage.id),
      title: parsed.title,
      truncated: false,
      htmlUrl: null,
    });
  }

  const inverted = buildInvertedIndex(source.id, files, passages);
  const bytes = chosen.reduce((sum, doc) => sum + doc.text.length, 0);
  return {
    index: {
      sourceId: source.id,
      builtAt: new Date().toISOString(),
      ref: 'local',
      resolvedRef: 'local',
      files,
      passages,
      ...inverted,
      stats: {
        filesIndexed: files.length,
        passages: passages.length,
        bytes,
        skipped: skipped.length,
        truncatedTree: false,
        truncatedFiles: 0,
      },
    },
    skipped,
  };
}

export interface LocalBrainStats {
  sources: number;
  files: number;
  passages: number;
  bytes: number;
}

/**
 * Owns the indexes and drives both engines for one question. One instance lives
 * for the lifetime of the app; adding a document rebuilds only its source.
 */
export class LocalBrain {
  private readonly logger = createLogger('production');
  private indexes = new Map<string, SourceIndex>();
  private sources = new Map<string, LocalSource>();
  private retriever = new Retriever(() =>
    [...this.indexes.values()].map((index) => ({
      index,
      sourceName: this.sources.get(index.sourceId)?.name ?? index.sourceId,
      htmlUrlFor: () => null,
    })),
  );

  private readonly knowledgeEngine = new KnowledgeEngine(
    this.logger,
    {
      totalPassages: () => [...this.indexes.values()].reduce((sum, index) => sum + index.passages.length, 0),
      stats: () => {
        const values = [...this.indexes.values()];
        return {
          totalFiles: values.reduce((sum, index) => sum + index.files.length, 0),
          readySources: values.length,
          totalPassages: values.reduce((sum, index) => sum + index.passages.length, 0),
        };
      },
      getIndex: (id: string) => this.indexes.get(id),
      listSources: () => [...this.sources.values()].map((source) => ({ id: source.id, name: source.name })),
    } as never,
    this.retriever,
  );

  private readonly answerEngine = new AnswerEngine(LOCAL_CONFIG, this.logger, noInference);

  /** Replaces or adds one source and re-indexes it. Returns what was skipped. */
  load(source: LocalSource): { indexed: number; passages: number; skipped: Array<{ path: string; reason: string }> } {
    const { index, skipped } = indexSource(source);
    this.sources.set(source.id, source);
    this.indexes.set(source.id, index);
    this.logger.info('local source indexed', {
      name: source.name,
      files: index.files.length,
      passages: index.passages.length,
      skipped: skipped.length,
    });
    return { indexed: index.files.length, passages: index.passages.length, skipped };
  }

  remove(id: string): void {
    this.sources.delete(id);
    this.indexes.delete(id);
  }

  stats(): LocalBrainStats {
    const values = [...this.indexes.values()];
    return {
      sources: values.length,
      files: values.reduce((sum, index) => sum + index.files.length, 0),
      passages: values.reduce((sum, index) => sum + index.passages.length, 0),
      bytes: [...this.sources.values()].reduce(
        (sum, source) => sum + source.docs.reduce((inner, doc) => inner + doc.text.length, 0),
        0,
      ),
    };
  }

  paths(): string[] {
    return [...this.indexes.values()].flatMap((index) => index.files.map((file) => file.path));
  }

  hasContent(): boolean {
    return [...this.indexes.values()].some((index) => index.passages.length > 0);
  }

  /**
   * Plain keyword search behind the sidebar search box. Same retriever as the
   * answer path, without evidence filtering: search is for browsing, answers are
   * for claiming.
   */
  search(
    query: string,
    options: { sourceIds?: string[]; limit?: number } = {},
  ): Array<{
    chunkId: string;
    sourceId: string;
    path: string;
    heading: string | null;
    startLine: number;
    endLine: number;
    score: number;
    signals: Record<string, number>;
    excerpt: string;
    kind: ChunkKind;
    language: string;
    htmlUrl: string | null;
  }> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];
    const result = this.retriever.retrieve(trimmed, {
      topK: options.limit ?? 12,
      sourceIds: options.sourceIds,
      preferDocs: true,
    });
    return result.hits.map((hit) => ({
      chunkId: hit.passage.id,
      sourceId: hit.passage.sourceId,
      path: hit.passage.path,
      heading: hit.passage.heading,
      startLine: hit.passage.startLine,
      endLine: hit.passage.endLine,
      score: Math.round(hit.score * 1000) / 1000,
      signals: hit.signals ?? {},
      excerpt: hit.passage.text.slice(0, 240),
      kind: hit.passage.kind,
      language: hit.passage.language,
      htmlUrl: null,
    }));
  }

  /**
   * Answers one question, emitting the same StreamEvents the SSE route emits, so
   * the UI does not know or care whether it is talking to a server.
   */
  async ask(input: {
    question: string;
    conversationId: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    emit: (event: StreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<AnswerPayload> {
    const started = Date.now();
    const { emit } = input;

    emit({ type: 'stage', stage: 'understanding' });
    const priorTerms = input.history
      .filter((turn) => turn.role === 'user')
      .flatMap((turn) => turn.content.split(/\s+/))
      .slice(-40);
    const { analysis, intent } = this.knowledgeEngine.understand(input.question, priorTerms);

    const memoryResult = buildMemory({
      history: input.history,
      current: analysis,
      maxTurns: LOCAL_CONFIG.maxHistoryTurns,
    });

    emit({ type: 'stage', stage: 'gathering' });
    const evidence = this.knowledgeEngine.gather({
      question: input.question,
      analysis,
      intent,
      priorTerms: memoryResult.state.expanded ? memoryResult.focusTerms : [],
      maxSnippets: 6,
      maxChars: LOCAL_CONFIG.maxContextChars,
    });

    if (evidence.expansion.concepts.length > 0) {
      emit({ type: 'stage', stage: 'gathering', detail: `searched your files for: ${evidence.expansion.concepts.join(', ')}` });
    }

    const corpus = this.knowledgeEngine.corpus();
    emit({
      type: 'meta',
      mode: 'knowledge',
      intent: intent.intent,
      inference: { ...noInference.status(), mode: 'knowledge' },
      memory: memoryResult.state,
      analysis,
      intentConfidence: intent.confidence,
    });

    const evidenceFiles = new Set(evidence.context.snippets.map((snippet) => snippet.path)).size;
    emit({
      type: 'stage',
      stage: 'evidence',
      detail: evidence.grounded
        ? `${evidence.context.snippets.length} passage(s) from ${evidenceFiles} file(s) in ${corpus.sources} source(s)`
        : 'no passage in your files supports this question',
    });

    const sources: SourceRef[] = evidence.sources.map((source) => ({ ...source, htmlUrl: null }));
    emit({ type: 'sources', sources });

    emit({ type: 'stage', stage: 'writing', detail: 'extractive writing' });
    const written = await this.answerEngine.write({
      question: input.question,
      conversationId: input.conversationId,
      history: input.history,
      analysis,
      intent,
      memory: memoryResult.state,
      context: evidence.context,
      hits: evidence.context.snippets.map((snippet) => ({
        passage: {
          id: String(snippet.id),
          sourceId: snippet.sourceId,
          path: snippet.path,
          heading: snippet.heading,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          kind: snippet.kind,
          language: snippet.language,
          text: snippet.text,
          tokens: [],
        } as never,
        score: snippet.score,
      })),
      coverage: evidence.coverage,
      corpus,
      onDelta: (text) => emit({ type: 'delta', text }),
      signal: input.signal,
    });

    emit({ type: 'stage', stage: 'verifying' });

    const payload: AnswerPayload = {
      ...written.payload,
      sources,
      codeFindings: evidence.codeFindings,
      timings: {
        analyze: evidence.timings.analyze,
        search: evidence.timings.search,
        rank: evidence.timings.rank,
        compose: written.timings.compose,
        validate: written.timings.validate,
        total: Date.now() - started,
      },
    };

    emit({ type: 'stage', stage: 'complete' });
    emit({ type: 'done', answer: payload });
    return payload;
  }
}
