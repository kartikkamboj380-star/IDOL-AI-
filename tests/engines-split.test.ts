/**
 * The two-engine split is load-bearing: the knowledge engine must be able to
 * say "I found nothing" without the answer engine inventing something, and the
 * answer engine must be able to write from a fixed evidence set without
 * searching. These tests pin that contract.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KnowledgeEngine } from '../server/engines/knowledge-engine.js';
import { AnswerEngine } from '../server/engines/answer-engine.js';
import { createLogger } from '../server/logger.js';
import { parseFile } from '../server/knowledge/file-types.js';
import { buildInvertedIndex, buildPassages } from '../server/knowledge/indexer.js';
import { Retriever } from '../server/knowledge/retriever.js';
import type { SourceIndex, SourceIndexFile } from '../server/knowledge/indexer.js';
import type { AppConfig } from '../server/config.js';
import type { KnowledgeService } from '../server/knowledge/service.js';
import type { InferenceAdapter } from '../server/inference/provider.js';

/** Builds one index from literal files, so tests read as fixtures. */
function indexOf(docs: Array<{ path: string; markdown?: string; code?: string }>): SourceIndex {
  const files: SourceIndexFile[] = [];
  const all = [];
  for (const doc of docs) {
    const raw = doc.markdown ?? doc.code ?? '';
    const parsed = parseFile(doc.path, raw);
    if (!parsed.ok) throw new Error(`parse failed: ${doc.path}`);
    const passages = buildPassages('ad-hoc', parsed, null, { maxChunks: 100 });
    all.push(...passages);
    files.push({
      path: doc.path,
      size: raw.length,
      sha: null,
      language: parsed.language,
      kind: parsed.kind,
      lineCount: parsed.lineCount,
      passageIds: passages.map((passage) => passage.id),
      title: parsed.title,
      truncated: false,
      htmlUrl: null,
    });
  }
  return {
    sourceId: 'ad-hoc',
    builtAt: new Date().toISOString(),
    ref: 'test',
    resolvedRef: 'test',
    files,
    passages: all,
    ...buildInvertedIndex('ad-hoc', files, all),
  } as unknown as SourceIndex;
}

const CORPUS = [
  {
    path: 'huggingface/demo/README.md',
    markdown: [
      '# Demo',
      '',
      'Demo reconstructs 3D objects from a single photo.',
      '',
      '## Across GPUs',
      '',
      '| GPU | VRAM | Request time |',
      '|---|---|---|',
      '| H100 | 80 GB | 6.7 s |',
      '| RTX 4090 | 24 GB | 19.1 s |',
      '| RTX 3080 | 10 GB | 46.2 s |',
      '',
    ].join('\n'),
  },
  {
    path: 'docs/ARCHITECTURE.md',
    markdown: [
      '# Architecture',
      '',
      'Retrieval runs BM25 over stemmed terms with a curated expansion vocabulary.',
      'Hardware requirements are out of scope for this document.',
      '',
    ].join('\n'),
  },
];

function makeServices(docs = CORPUS) {
  const index = indexOf(docs);
  const retriever = new Retriever(() => [{ index, sourceName: 'test', htmlUrlFor: () => null }]);
  const knowledge = {
    totalPassages: () => index.passages.length,
    stats: () => ({ totalFiles: index.files.length, readySources: 1, totalPassages: index.passages.length }),
    getIndex: () => index,
    listSources: () => [{ id: 'ad-hoc', name: 'test' }],
  } as unknown as KnowledgeService;
  const logger = createLogger("test");
  return { retriever, knowledge, logger };
}

const CONFIG = {
  maxHistoryTurns: 6,
  maxContextChars: 12000,
  inference: { maxTokens: 700, temperature: 0.2 },
} as AppConfig;

/** An inference adapter that is configured but always fails. */
function failingInference(): InferenceAdapter {
  return {
    status: () => ({ available: true, provider: 'test', model: 'test-model', reason: null, mode: 'inference' }),
    buildPrompt: () => ({ system: 's', user: 'u' }),
    generate: async () => {
      throw new Error('provider offline');
    },
  } as unknown as InferenceAdapter;
}

function absentInference(): InferenceAdapter {
  return {
    status: () => ({
      available: false,
      provider: null,
      model: null,
      reason: 'No inference provider is configured.',
      mode: 'knowledge',
    }),
  } as unknown as InferenceAdapter;
}

describe('knowledge engine', () => {
  it('returns the passage that actually holds the answer', () => {
    const { retriever, knowledge, logger } = makeServices();
    const engine = new KnowledgeEngine(logger, knowledge, retriever);
    const result = engine.gather({ question: 'How much VRAM do I need?' });

    assert.equal(result.grounded, true);
    assert.ok(result.context.snippets.length > 0);
    assert.equal(result.context.snippets[0]?.path, 'huggingface/demo/README.md');
    assert.match(result.context.snippets[0]?.text ?? '', /80 GB/);
  });

  it('reports what it rejected instead of silently dropping noise', () => {
    const { retriever, knowledge, logger } = makeServices();
    const engine = new KnowledgeEngine(logger, knowledge, retriever);
    const result = engine.gather({ question: 'How much VRAM do I need?' });

    assert.ok(result.candidates >= result.context.snippets.length);
    assert.equal(result.discarded, result.candidates - result.context.snippets.length);
  });

  it('refuses to claim evidence for a question the corpus does not cover', () => {
    const { retriever, knowledge, logger } = makeServices();
    const engine = new KnowledgeEngine(logger, knowledge, retriever);
    const result = engine.gather({ question: 'What is the airspeed velocity of an unladen swallow?' });

    assert.equal(result.grounded, false, 'a question with no corpus terms must not be called grounded');
    assert.equal(result.context.snippets.length, 0);
  });

  it('never searches when asked to understand only', () => {
    const { retriever, knowledge, logger } = makeServices();
    let searches = 0;
    const spy = new Retriever(() => []) as unknown as Retriever;
    Object.defineProperty(spy, 'retrieve', {
      value: () => {
        searches += 1;
        return { hits: [], timings: {} };
      },
    });
    void retriever;
    const engine = new KnowledgeEngine(logger, knowledge, spy);
    const { analysis, intent } = engine.understand('How much VRAM do I need?');

    assert.equal(searches, 0, 'understand() must not touch the index');
    assert.equal(analysis.raw, 'How much VRAM do I need?');
    assert.equal(intent.intent, 'factual_lookup');
  });
});

describe('answer engine', () => {
  async function evidenceFor(question: string) {
    const { retriever, knowledge, logger } = makeServices();
    const engine = new KnowledgeEngine(logger, knowledge, retriever);
    return engine.gather({ question });
  }

  it('writes an extractive answer with no model configured', async () => {
    const evidence = await evidenceFor('How much VRAM do I need?');
    const engine = new AnswerEngine(CONFIG, createLogger("test"), absentInference());
    const deltas: string[] = [];

    const result = await engine.write({
      question: 'How much VRAM do I need?',
      conversationId: 'test',
      history: [],
      analysis: evidence.analysis,
      intent: evidence.intent,
      memory: { topic: null, focusTerms: [], turnCount: 0, expanded: false, note: '' },
      context: evidence.context,
      hits: [],
      coverage: evidence.coverage,
      corpus: { passages: 10, files: 2, sources: 1 },
      onDelta: (text) => deltas.push(text),
    });

    assert.equal(result.usedMode, 'knowledge');
    assert.match(result.payload.text, /No language model was used/);
    assert.ok(deltas.length > 0, 'the answer must stream to the client');
  });

  it('answers from the app voice when there is no evidence', async () => {
    const evidence = await evidenceFor('What is the airspeed velocity of an unladen swallow?');
    const engine = new AnswerEngine(CONFIG, createLogger("test"), absentInference());

    const result = await engine.write({
      question: 'What is the airspeed velocity of an unladen swallow?',
      conversationId: 'test',
      history: [],
      analysis: evidence.analysis,
      intent: evidence.intent,
      memory: { topic: null, focusTerms: [], turnCount: 0, expanded: false, note: '' },
      context: evidence.context,
      hits: [],
      coverage: evidence.coverage,
      corpus: { passages: 10, files: 2, sources: 1 },
    });

    assert.equal(result.payload.confidence, 'none');
    assert.equal(result.payload.sources.length, 0);
  });

  it('falls back to extractive writing when the model call fails', async () => {
    const evidence = await evidenceFor('How much VRAM do I need?');
    const engine = new AnswerEngine(CONFIG, createLogger("test"), failingInference());

    const result = await engine.write({
      question: 'How much VRAM do I need?',
      conversationId: 'test',
      history: [],
      analysis: evidence.analysis,
      intent: evidence.intent,
      memory: { topic: null, focusTerms: [], turnCount: 0, expanded: false, note: '' },
      context: evidence.context,
      hits: [],
      coverage: evidence.coverage,
      corpus: { passages: 10, files: 2, sources: 1 },
    });

    assert.equal(result.usedMode, 'knowledge', 'a provider outage must degrade style, not lose the answer');
    assert.ok(result.payload.text.length > 0);
    assert.match(result.payload.provenance, /Extractive answer/);
  });

  it('verifies every citation it emits against a real passage', async () => {
    const evidence = await evidenceFor('How much VRAM do I need?');
    const engine = new AnswerEngine(CONFIG, createLogger("test"), absentInference());

    const result = await engine.write({
      question: 'How much VRAM do I need?',
      conversationId: 'test',
      history: [],
      analysis: evidence.analysis,
      intent: evidence.intent,
      memory: { topic: null, focusTerms: [], turnCount: 0, expanded: false, note: '' },
      context: evidence.context,
      hits: [],
      coverage: evidence.coverage,
      corpus: { passages: 10, files: 2, sources: 1 },
    });

    assert.ok(result.validation.citations.length > 0);
    const knownIds = new Set(evidence.context.snippets.map((snippet) => snippet.id));
    for (const citation of result.validation.citations) {
      assert.ok(knownIds.has(citation.marker), `citation ${citation.marker} does not point at a retrieved passage`);
    }
  });
});
