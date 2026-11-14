/**
 * Answer pipeline — wires every engine together for one question.
 *
 * Order of operations (streamed to the client as stages):
 *   analyze → memory → search → rank → context → compose → validate
 *
 * The pipeline is transport-agnostic: it emits `StreamEvent` objects and the
 * route turns them into SSE. This makes the whole journey testable without HTTP.
 */
import type {
  AnswerMode,
  AnswerPayload,
  CodeFinding,
  IntentResult,
  MemoryState,
  QuestionAnalysis,
  SourceRef,
  StreamEvent,
  ValidationReport,
} from '../../shared/types.js';
import type { Logger } from '../logger.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { Retriever } from '../knowledge/retriever.js';
import type { InferenceAdapter } from '../inference/provider.js';
import type { AppConfig } from '../config.js';
import { analyzeQuestion, detectFileTargets } from './question-analyzer.js';
import { expandQuery } from './expansion.js';
import { detectIntent } from './intent.js';
import { buildMemory } from './memory.js';
import { buildContext } from './context-builder.js';
import { composeKnowledgeAnswer, computeCoverage } from './answer-composer.js';
import { aggregateFindings, analyzePassage } from './code-analysis.js';
import { validateAnswer } from './validator.js';
import { newId } from '../util/common.js';
import { contentTerms } from '../knowledge/text.js';
import { InferenceError } from '../inference/provider.js';

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
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly knowledge: KnowledgeService,
    private readonly retriever: Retriever,
    private readonly inference: InferenceAdapter,
  ) {}

  async run(input: PipelineInput): Promise<PipelineResult> {
    const started = Date.now();
    const timings: Record<string, number> = {};
    const mark = (label: string, since: number): number => {
      const elapsed = Date.now() - since;
      timings[label] = elapsed;
      return elapsed;
    };

    /* 1 — Question analysis ------------------------------------------- */
    let t = Date.now();
    input.emit({ type: 'stage', stage: 'analyzing' });
    const analysis: QuestionAnalysis = analyzeQuestion(input.question, {
      priorTerms: input.history.filter((turn) => turn.role === 'user').flatMap((turn) => turn.content.split(/\s+/)).slice(-40),
    });
    const intent: IntentResult = detectIntent(analysis);
    mark('analyze', t);

    /* 2 — Memory ------------------------------------------------------- */
    t = Date.now();
    input.emit({ type: 'stage', stage: 'memory' });
    const memory = buildMemory({ history: input.history, current: analysis, maxTurns: this.config.maxHistoryTurns });
    const memoryState: MemoryState = memory.state;
    mark('memory', t);

    const corpus = {
      passages: this.knowledge.totalPassages(),
      files: this.knowledge.stats().totalFiles,
      sources: this.knowledge.stats().readySources,
    };

    const inferenceStatus = this.inference.status();

    /* 3 — Retrieval ---------------------------------------------------- */
    t = Date.now();
    input.emit({
      type: 'stage',
      stage: 'searching',
      detail: `${corpus.passages.toLocaleString()} passages`,
    });
    const preferCode = intent.intent === 'code_explanation' || intent.intent === 'bug_analysis';
    // "Summarise the README" names a file, not a topic: restrict retrieval to
    // matching paths and strip the filename word from the keyword query.
    const pathTargets = detectFileTargets(analysis.normalized);
    const retrievalTerms =
      pathTargets.length > 0
        ? analysis.terms.filter((term) => !pathTargets.some((target) => target.startsWith(term) || term.startsWith(target)))
        : analysis.terms;
    const expansion =
      intent.intent === 'out_of_scope' ? { terms: [], concepts: [] } : expandQuery(retrievalTerms, 12);
    if (expansion.concepts.length > 0) {
      input.emit({ type: 'stage', stage: 'searching', detail: `expanded with: ${expansion.concepts.join(', ')}` });
    }
    const retrievalQuery =
      pathTargets.length > 0 ? retrievalTerms.join(' ') || analysis.normalized : memory.retrievalQuery;
    const retrieval = this.retriever.retrieve(retrievalQuery, {
      topK: intent.intent === 'summarization' ? 10 : 8,
      sourceIds: input.sourceIds,
      preferDocs: !preferCode,
      preferCode,
      memoryTerms: memoryState.expanded ? memory.focusTerms : [],
      expansionTerms: expansion.terms,
      pathTargets,
      intent: intent.intent,
    });
    mark('search', t);

    /* 4 — Ranking / context ------------------------------------------- */
    t = Date.now();
    input.emit({ type: 'stage', stage: 'ranking', detail: `${retrieval.hits.length} candidate passages` });

    const conversational = intent.intent === 'greeting' || intent.intent === 'capabilities';
    const topScore = retrieval.hits[0]?.score ?? 0;
    // Relevance gate: a hit must clear a floor and stay within reach of the best
    // hit, otherwise it is noise and must not appear as a source. Conversational
    // intents ("hi", "what can you do") are answered from the app's own
    // capabilities, so they cite nothing at all.
    const floor = conversational ? Number.POSITIVE_INFINITY : Math.max(0.9, topScore * 0.18);
    const relevantHits = retrieval.hits.filter((hit) => hit.score >= floor);

    // Hard evidence guard: the retriever's lexical matching can score "the",
    // the numbers in a query, or query-expansion terms, none of which is proof
    // that the corpus covers the question. If none of the question's own content
    // terms occur in any retrieved passage, there is no evidence, and the answer
    // must say so instead of quoting something unrelated.
    const questionTerms = new Set([...analysis.terms, ...contentTerms(input.question).terms]);
    const lexicalEvidence = relevantHits.some((hit) => {
      const haystack = `${hit.path} ${hit.passage.heading ?? ''} ${hit.passage.text}`.toLowerCase();
      return [...questionTerms].some((term) => term.length > 2 && haystack.includes(term));
    });
    if (!lexicalEvidence && !conversational) {
      relevantHits.length = 0;
    }

    input.emit({ type: 'stage', stage: 'context' });
    const context = buildContext({
      hits: relevantHits.map((hit) => {
        const index = this.knowledge.getIndex(hit.sourceId);
        const source = this.knowledge.listSources().find((item) => item.id === hit.sourceId);
        return {
          passage: hit.passage,
          score: hit.score,
          sourceName: source?.name ?? hit.sourceId,
          htmlUrl: index ? hit.htmlUrl : null,
        };
      }),
      maxChars: this.config.maxContextChars,
      maxSnippets: 6,
      maxPerFile: 3,
      minRelativeScore: 0,
    });
    mark('rank', t);

    const coverage = computeCoverage(analysis, context.snippets, pathTargets);
    const codeFindings: CodeFinding[] = aggregateFindings(
      relevantHits.slice(0, 6).flatMap((hit) => analyzePassage(hit.passage)),
    );

    const mode: AnswerMode = inferenceStatus.available ? 'inference' : 'knowledge';

    input.emit({
      type: 'meta',
      mode,
      intent: intent.intent,
      inference: { ...inferenceStatus, mode },
      memory: memoryState,
      analysis,
      intentConfidence: intent.confidence,
    });
    input.emit({ type: 'sources', sources: context.sources });

    /* 5 — Generation --------------------------------------------------- */
    t = Date.now();
    input.emit({ type: 'stage', stage: 'composing', detail: mode === 'inference' ? 'grounded generation' : 'extractive summarisation' });

    let answerText = '';
    let usedMode: AnswerMode = mode;
    let model: string | null = null;
    let inferenceNote: string | undefined;

    const composeInput = {
      question: input.question,
      analysis,
      intent,
      memory: memoryState,
      context,
      hits: relevantHits.map((hit) => ({ passage: hit.passage, score: hit.score })),
      coverage,
      corpus,
      mode,
    };

    const needsKnowledgeCompose =
      intent.intent === 'greeting' || intent.intent === 'capabilities' || context.snippets.length === 0;

    if (mode === 'inference' && !needsKnowledgeCompose) {
      try {
        const prompt = this.inference.buildPrompt({
          question: input.question,
          contextText: context.text,
          historyTurns: input.history.slice(-4),
          intent: intent.intent,
          sourcesList: context.sources.map((source) => `[${source.id}] ${source.path} (lines ${source.startLine}-${source.endLine})`).join('\n'),
        });
        let streamed = '';
        const result = await this.inference.generate({
          system: prompt.system,
          user: prompt.user,
          maxTokens: this.config.inference.maxTokens,
          temperature: this.config.inference.temperature,
          signal: input.signal,
          onDelta: (delta) => {
            streamed += delta;
            input.emit({ type: 'delta', text: delta });
          },
        });
        answerText = result.text;
        model = result.model;
        inferenceNote = `${result.provider} · ${result.model}`;
        if (streamed.length === 0) input.emit({ type: 'delta', text: result.text });
      } catch (error) {
        this.logger.warn('inference generation failed; using knowledge mode for this answer', { error });
        usedMode = 'knowledge';
        if (error instanceof InferenceError) inferenceNote = error.message;
        const fallback = composeKnowledgeAnswer({ ...composeInput, mode: 'knowledge' });
        answerText = fallback.text;
        input.emit({ type: 'delta', text: fallback.text });
      }
    } else {
      if (mode === 'inference' && context.snippets.length === 0) usedMode = 'knowledge';
      const composed = composeKnowledgeAnswer({ ...composeInput, mode: usedMode });
      answerText = composed.text;
      input.emit({ type: 'delta', text: composed.text });
    }
    mark('compose', t);

    /* 6 — Validation --------------------------------------------------- */
    t = Date.now();
    input.emit({ type: 'stage', stage: 'validating' });
    const validation = validateAnswer({
      answer: answerText,
      snippets: context.snippets,
      strictQuotes: usedMode === 'inference',
    });
    answerText = validation.text;
    const report: ValidationReport = validation.report;
    mark('validate', t);

    const sources: SourceRef[] = context.sources.map((source) => {
      const citation = report.citations.find((entry) => entry.marker === source.id);
      return citation ? source : { ...source };
    });

    const confidence = deriveConfidence(report, context.sources.length, usedMode);

    mark('total', started);
    const payload: AnswerPayload = {
      id: newId('ans'),
      conversationId: input.conversationId,
      createdAt: new Date().toISOString(),
      text: answerText,
      mode: usedMode,
      intent: intent.intent,
      intentConfidence: intent.confidence,
      confidence,
      sources,
      memory: memoryState,
      validation: report,
      analysis,
      codeFindings,
      timings,
      model,
      provenance:
        usedMode === 'inference'
          ? `Generated by ${inferenceNote ?? 'the configured inference provider'} from ${context.sources.length} retrieved passage(s); citations validated.`
          : `Extractive answer composed from ${context.sources.length} retrieved passage(s) of the indexed repository knowledge. No language model was used.`,
    };

    input.emit({ type: 'stage', stage: 'complete' });
    input.emit({ type: 'done', answer: payload });
    return { payload };
  }
}

function deriveConfidence(
  report: ValidationReport,
  sourceCount: number,
  mode: AnswerMode,
): 'high' | 'medium' | 'low' | 'none' {
  if (sourceCount === 0) return 'none';
  if (report.citations.length === 0) return 'low';
  if (mode === 'inference' && report.citationCoverage >= 0.6 && sourceCount >= 2) return 'high';
  if (report.citations.length >= 2 && report.passed) return 'high';
  if (report.passed) return 'medium';
  return 'low';
}
