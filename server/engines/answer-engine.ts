/**
 * AnswerEngine — engine #2 of two.
 *
 * It writes the answer. It never searches: it receives a fixed evidence set from
 * the KnowledgeEngine and has exactly one decision to make — which words to use,
 * and where each claim came from.
 *
 *   compose from evidence → stream → validate citations → report
 *
 * Two writers exist behind the same interface:
 *
 *   - `extractive` (default): sentences and tables lifted verbatim from the
 *     evidence. Every word is traceable to a file and a line. No model is called,
 *     so it cannot invent anything, and it is slower to be charming but never
 *     wrong about which file said what.
 *   - `inference`: an OpenAI-compatible model writes prose from the same evidence.
 *     It is allowed to be fluent; it is not allowed to cite a passage that does
 *     not exist, which is what validateAnswer() enforces.
 *
 * If the model fails, the engine falls back to the extractive writer rather than
 * returning an error, so a provider outage degrades the style, not the answer.
 */
import type {
  AnswerMode,
  AnswerPayload,
  IntentResult,
  MemoryState,
  QuestionAnalysis,
  SourceRef,
  ValidationReport,
} from '../../shared/types.js';
import type { Logger } from '../logger.js';
import type { AppConfig } from '../config.js';
import type { ModelAdapter } from '../inference/contract.js';
import type { BuiltContext } from './context-builder.js';
import type { Passage } from '../knowledge/indexer.js';
import { composeKnowledgeAnswer } from './answer-composer.js';
import { validateAnswer } from './validator.js';
import { ModelUnavailableError } from '../inference/contract.js';
import { newId } from '../util/common.js';

export interface AnswerInput {
  question: string;
  conversationId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  analysis: QuestionAnalysis;
  intent: IntentResult;
  memory: MemoryState;
  context: BuiltContext;
  hits: Array<{ passage: Passage; score: number }>;
  coverage: { matched: string[]; missing: string[] };
  corpus: { passages: number; files: number; sources: number };
  /** Emits streamed text so the UI types the answer out. */
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface AnswerResult {
  payload: AnswerPayload;
  validation: ValidationReport;
  usedMode: AnswerMode;
  timings: { compose: number; validate: number };
}

export class AnswerEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly inference: ModelAdapter,
  ) {}

  /** Which writer will run for this request, and why. */
  mode(): { mode: AnswerMode; reason: string | null } {
    const status = this.inference.status();
    return { mode: status.available ? 'inference' : 'knowledge', reason: status.reason ?? null };
  }

  async write(input: AnswerInput): Promise<AnswerResult> {
    const t1 = Date.now();

    const conversational = input.intent.intent === 'greeting' || input.intent.intent === 'capabilities';
    const hasEvidence = input.context.snippets.length > 0;
    // Conversational turns and evidence-free questions are answered from the app's
    // own voice, never by a model: there is nothing to ground them in.
    const wantsModel = this.inference.status().available && !conversational && hasEvidence;

    let answerText = '';
    let usedMode: AnswerMode = wantsModel ? 'inference' : 'knowledge';
    let model: string | null = null;
    let inferenceNote: string | undefined;

    const composeInput = {
      question: input.question,
      analysis: input.analysis,
      intent: input.intent,
      memory: input.memory,
      context: input.context,
      hits: input.hits,
      coverage: input.coverage,
      corpus: input.corpus,
      mode: usedMode,
    };

    if (wantsModel) {
      try {
        const prompt = this.inference.buildPrompt({
          question: input.question,
          contextText: input.context.text,
          historyTurns: input.history.slice(-4),
          intent: input.intent.intent,
          sourcesList: input.context.sources
            .map((source) => `[${source.id}] ${source.path} (lines ${source.startLine}-${source.endLine})`)
            .join('\n'),
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
            input.onDelta?.(delta);
          },
        });
        answerText = result.text;
        model = result.model;
        inferenceNote = `${result.provider} · ${result.model}`;
        if (streamed.length === 0) input.onDelta?.(result.text);
      } catch (error) {
        // A provider failure must not lose the answer: fall back to extractive.
        this.logger.warn('inference generation failed; falling back to extractive writing', { error });
        usedMode = 'knowledge';
        if (error instanceof ModelUnavailableError) inferenceNote = error.message;
        const fallback = composeKnowledgeAnswer({ ...composeInput, mode: 'knowledge' });
        answerText = fallback.text;
        input.onDelta?.(fallback.text);
      }
    } else {
      const composed = composeKnowledgeAnswer({ ...composeInput, mode: usedMode });
      answerText = composed.text;
      input.onDelta?.(composed.text);
    }
    const composeMs = Date.now() - t1;

    /* Validation — every citation must resolve to a real retrieved passage. */
    const t2 = Date.now();
    const validation = validateAnswer({
      answer: answerText,
      snippets: input.context.snippets,
      strictQuotes: usedMode === 'inference',
    });
    answerText = validation.text;
    const report: ValidationReport = validation.report;
    const validateMs = Date.now() - t2;

    const sources: SourceRef[] = input.context.sources.map((source) => {
      const citation = report.citations.find((entry) => entry.marker === source.id);
      return citation ? source : { ...source };
    });

    const payload: AnswerPayload = {
      id: newId('ans'),
      conversationId: input.conversationId,
      createdAt: new Date().toISOString(),
      text: answerText,
      mode: usedMode,
      intent: input.intent.intent,
      intentConfidence: input.intent.confidence,
      confidence: deriveConfidence(report, input.context.sources.length, usedMode),
      sources,
      memory: input.memory,
      validation: report,
      analysis: input.analysis,
      codeFindings: [],
      timings: { compose: composeMs, validate: validateMs },
      model,
      provenance:
        usedMode === 'inference'
          ? `Generated by ${inferenceNote ?? 'the configured inference provider'} from ${input.context.sources.length} retrieved passage(s); citations validated.`
          : inferenceNote
            ? `Extractive answer composed from ${input.context.sources.length} retrieved passage(s). The model call failed (${inferenceNote}), so the extractive writer was used.`
            : `Extractive answer composed from ${input.context.sources.length} retrieved passage(s) of the indexed repository knowledge. No language model was used.`,
    };

    return { payload, validation: report, usedMode, timings: { compose: composeMs, validate: validateMs } };
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
