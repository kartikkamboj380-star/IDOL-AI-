/**
 * Answer pipeline — the conductor for the two engines.
 *
 *   KnowledgeEngine.gather()  →  AnswerEngine.write()
 *        (GitHub brain)              (the writer)
 *
 * The pipeline owns only sequencing and transport concerns: it resolves
 * conversation memory, hands the evidence set from one engine to the other, and
 * streams each engine's progress to the client. It contains no retrieval logic
 * and no composition logic, so both engines stay independently testable.
 *
 * Stages streamed to the client mirror the user-visible story:
 *   understanding → your question becomes search terms and intent
 *   gathering     → the knowledge engine searches GitHub sources
 *   evidence      → what was found, and what was rejected as noise
 *   writing       → the answer engine writes from that evidence
 *   verifying     → every citation is checked against a real passage
 */
import type {
  AnswerPayload,
  MemoryState,
  StreamEvent,
  ValidationReport,
} from '../../shared/types.js';
import type { Logger } from '../logger.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { Retriever } from '../knowledge/retriever.js';
import type { ModelAdapter } from '../inference/contract.js';
import type { AppConfig } from '../config.js';
import { buildMemory } from './memory.js';
import { KnowledgeEngine } from './knowledge-engine.js';
import { AnswerEngine } from './answer-engine.js';

export interface PipelineInput {
  question: string;
  conversationId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  sourceIds?: string[];
  /** Called for every stream event (SSE). */
  emit: (event: StreamEvent) => void;
  /** Aborts generation when the user presses Stop. */
  signal?: AbortSignal;
}

export interface PipelineResult {
  payload: AnswerPayload;
}

export class AnswerPipeline {
  private readonly knowledgeEngine: KnowledgeEngine;
  private readonly answerEngine: AnswerEngine;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly knowledge: KnowledgeService,
    private readonly retriever: Retriever,
    private readonly inference: ModelAdapter,
  ) {
    this.knowledgeEngine = new KnowledgeEngine(logger, knowledge, retriever);
    this.answerEngine = new AnswerEngine(config, logger, inference);
  }

  async run(input: PipelineInput): Promise<PipelineResult> {
    const started = Date.now();
    const timings: Record<string, number> = {};

    /* 1 — KNOWLEDGE ENGINE, part 1: read the question -------------------- */
    input.emit({ type: 'stage', stage: 'understanding' });
    const priorTerms = input.history
      .filter((turn) => turn.role === 'user')
      .flatMap((turn) => turn.content.split(/\s+/))
      .slice(-40);
    const { analysis, intent } = this.knowledgeEngine.understand(input.question, priorTerms);

    /* 2 — Conversation memory: what does "it" refer to? ------------------ */
    const memory = buildMemory({
      history: input.history,
      current: analysis,
      maxTurns: this.config.maxHistoryTurns,
    });
    const memoryState: MemoryState = memory.state;

    /* 3 — KNOWLEDGE ENGINE, part 2: gather evidence ---------------------- */
    input.emit({ type: 'stage', stage: 'gathering' });
    const evidence = this.knowledgeEngine.gather({
      question: input.question,
      analysis,
      intent,
      sourceIds: input.sourceIds,
      priorTerms: memoryState.expanded ? memory.focusTerms : [],
      maxSnippets: 6,
      maxChars: this.config.maxContextChars,
    });

    if (evidence.expansion.concepts.length > 0) {
      input.emit({
        type: 'stage',
        stage: 'gathering',
        detail: `searched GitHub for: ${evidence.expansion.concepts.join(', ')}`,
      });
    }

    const corpus = this.knowledgeEngine.corpus();
    const modeInfo = this.answerEngine.mode();

    input.emit({
      type: 'meta',
      mode: modeInfo.mode,
      intent: evidence.intent.intent,
      inference: {
        ...this.inference.status(),
        mode: modeInfo.mode,
      },
      memory: memoryState,
      analysis: evidence.analysis,
      intentConfidence: evidence.intent.confidence,
    });

    /* 3 — Evidence report: what survived, what was rejected -------------- */
    // `sources` is the citation list (one entry per passage); the number of
    // repositories actually searched comes from the knowledge engine's corpus.
    const evidenceFiles = new Set(evidence.context.snippets.map((snippet) => snippet.path)).size;
    input.emit({
      type: 'stage',
      stage: 'evidence',
      detail: evidence.grounded
        ? `${evidence.context.snippets.length} passage(s) from ${evidenceFiles} file(s) in ${corpus.sources} source(s)`
        : 'no passage in the indexed sources supports this question',
    });
    input.emit({ type: 'sources', sources: evidence.sources });

    /* 4 — ANSWER ENGINE: write from that evidence ------------------------ */
    input.emit({
      type: 'stage',
      stage: 'writing',
      detail: modeInfo.mode === 'inference' ? 'writing with the configured model' : 'extractive writing',
    });

    const written = await this.answerEngine.write({
      question: input.question,
      conversationId: input.conversationId,
      history: input.history,
      analysis: evidence.analysis,
      intent: evidence.intent,
      memory: memoryState,
      context: evidence.context,
      hits: evidence.context.snippets.map((snippet) => ({
        // ComposeInput only reads `passage` fields that the snippet already
        // carries; this keeps one evidence set shared by both engines.
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
      onDelta: (text) => input.emit({ type: 'delta', text }),
      signal: input.signal,
    });

    /* 5 — Verification is part of writing, not a separate stage ---------- */
    input.emit({ type: 'stage', stage: 'verifying' });
    const report: ValidationReport = written.validation;

    timings.analyze = evidence.timings.analyze;
    timings.search = evidence.timings.search;
    timings.rank = evidence.timings.rank;
    timings.compose = written.timings.compose;
    timings.validate = written.timings.validate;
    timings.total = Date.now() - started;

    const payload: AnswerPayload = {
      ...written.payload,
      // Evidence-derived fields the writer does not own.
      codeFindings: evidence.codeFindings,
      timings,
      validation: report,
    };

    this.logger.info('answer complete', {
      mode: written.usedMode,
      grounded: evidence.grounded,
      candidates: evidence.candidates,
      kept: evidence.context.snippets.length,
      ms: timings.total,
    });

    input.emit({ type: 'stage', stage: 'complete' });
    input.emit({ type: 'done', answer: payload });
    return { payload };
  }
}
