/**
 * KnowledgeEngine — engine #1 of two.
 *
 * Its single job is to turn a question into evidence. It does not write answers.
 * Given a question it decides how to search, searches every ready GitHub source,
 * and returns only the passages that can actually support a claim:
 *
 *   analyse → expand → search GitHub sources → rank → filter for real evidence
 *
 * Splitting this out of the answer composer is deliberate. Retrieval quality is
 * something you can measure on its own ("did the right file come back?"), and the
 * writer downstream can then be judged on a fixed set of evidence instead of on
 * whatever it happened to recall.
 *
 * No git push, no network beyond the sources the user configured, no writes.
 */
import type {
  CodeFinding,
  IntentResult,
  QuestionAnalysis,
  SourceRef,
} from '../../shared/types.js';
import type { Logger } from '../logger.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { Retriever } from '../knowledge/retriever.js';
import type { BuiltContext } from './context-builder.js';
import { analyzeQuestion, detectFileTargets } from './question-analyzer.js';
import { expandQuery } from './expansion.js';
import { detectIntent } from './intent.js';
import { buildContext } from './context-builder.js';
import { aggregateFindings, analyzePassage } from './code-analysis.js';
import { computeCoverage } from './answer-composer.js';
import { contentTerms } from '../knowledge/text.js';

export interface KnowledgeInput {
  question: string;
  /** Pre-computed analysis from understand(); recomputed when omitted. */
  analysis?: QuestionAnalysis;
  intent?: IntentResult;
  /** Restrict retrieval to these source ids; all ready sources when omitted. */
  sourceIds?: string[];
  /** Content terms from earlier user turns, used for pronoun-only follow-ups. */
  priorTerms?: string[];
  /** Retrieval output is capped by this many snippets. */
  maxSnippets?: number;
  maxChars?: number;
}

export interface KnowledgeResult {
  analysis: QuestionAnalysis;
  intent: IntentResult;
  /** Search terms after expansion, exposed so the UI can show what was searched. */
  expansion: { terms: string[]; concepts: string[] };
  retrievalQuery: string;
  /** Passages that passed the evidence filter, in rank order. */
  context: BuiltContext;
  /** Raw hit count before filtering — a useful signal for "we found nothing". */
  candidates: number;
  /** How many passages were thrown out for failing the evidence test. */
  discarded: number;
  /** True when the corpus lexically covers the question. */
  grounded: boolean;
  codeFindings: CodeFinding[];
  coverage: { matched: string[]; missing: string[] };
  pathTargets: string[];
  sources: SourceRef[];
  timings: { analyze: number; search: number; rank: number };
}

export class KnowledgeEngine {
  constructor(
    private readonly logger: Logger,
    private readonly knowledge: KnowledgeService,
    private readonly retriever: Retriever,
  ) {}

  /** Number of passages available to search, for status display. */
  corpus(): { passages: number; files: number; sources: number } {
    const stats = this.knowledge.stats();
    return {
      passages: this.knowledge.totalPassages(),
      files: stats.totalFiles,
      sources: stats.readySources,
    };
  }

  /** Step 1 of the engine, exposed separately so memory can run in between. */
  understand(question: string, priorTerms?: string[]): { analysis: QuestionAnalysis; intent: IntentResult } {
    const analysis = analyzeQuestion(question, { priorTerms: priorTerms?.slice(-40) });
    return { analysis, intent: detectIntent(analysis) };
  }

  /**
   * Builds the evidence set for one question. Pure with respect to the app: it
   * reads indexes and returns data, so it can be unit-tested without a server.
   */
  gather(input: KnowledgeInput): KnowledgeResult {
    const started = Date.now();

    /* 1 — Understand the question -------------------------------------- */
    const t1 = Date.now();
    const analysis = input.analysis ?? analyzeQuestion(input.question, { priorTerms: input.priorTerms?.slice(-40) });
    const intent = input.intent ?? detectIntent(analysis);
    const analyzeMs = Date.now() - t1;

    /* 2 — Decide what to search ---------------------------------------- */
    const t2 = Date.now();
    const preferCode = intent.intent === 'code_explanation' || intent.intent === 'bug_analysis';
    // "Summarise the README" names a file, not a topic: restrict retrieval to
    // matching paths and drop the filename word from the keyword query.
    const pathTargets = detectFileTargets(analysis.normalized);
    const retrievalTerms =
      pathTargets.length > 0
        ? analysis.terms.filter(
            (term) => !pathTargets.some((target) => target.startsWith(term) || term.startsWith(target)),
          )
        : analysis.terms;
    const expansion =
      intent.intent === 'out_of_scope' ? { terms: [] as string[], concepts: [] as string[] } : expandQuery(retrievalTerms, 12);
    const retrievalQuery =
      pathTargets.length > 0 ? retrievalTerms.join(' ') || analysis.normalized : retrievalTerms.join(' ') || analysis.normalized;

    /* 3 — Search every ready source ------------------------------------ */
    const retrieval = this.retriever.retrieve(retrievalQuery, {
      topK: intent.intent === 'summarization' ? 10 : 8,
      sourceIds: input.sourceIds,
      preferDocs: !preferCode,
      preferCode,
      expansionTerms: expansion.terms,
      pathTargets,
      intent: intent.intent,
    });
    const searchMs = Date.now() - t2;

    /* 4 — Keep only real evidence -------------------------------------- */
    const t3 = Date.now();
    const conversational = intent.intent === 'greeting' || intent.intent === 'capabilities';
    const topScore = retrieval.hits[0]?.score ?? 0;
    // A hit must clear an absolute floor and stay within reach of the best hit,
    // otherwise it is noise and must not be shown as a source.
    const floor = conversational ? Number.POSITIVE_INFINITY : Math.max(0.9, topScore * 0.18);
    const relevantHits = retrieval.hits.filter((hit) => hit.score >= floor);

    // Hard evidence guard: lexical matching can score "the", numbers, or expansion
    // terms, none of which proves the corpus covers the question. If none of the
    // question's own content terms appear in any retrieved passage, there is no
    // evidence and the answer must say so rather than quote something unrelated.
    const questionTerms = new Set([...analysis.terms, ...contentTerms(input.question).terms]);
    const lexicalEvidence = relevantHits.some((hit) => {
      const haystack = `${hit.path} ${hit.passage.heading ?? ''} ${hit.passage.text}`.toLowerCase();
      return [...questionTerms].some((term) => term.length > 2 && haystack.includes(term));
    });
    const grounded = conversational || lexicalEvidence;
    if (!grounded) relevantHits.length = 0;

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
      maxChars: input.maxChars ?? 12000,
      maxSnippets: input.maxSnippets ?? 6,
      maxPerFile: 3,
      minRelativeScore: 0,
    });

    const codeFindings = aggregateFindings(relevantHits.slice(0, 6).flatMap((hit) => analyzePassage(hit.passage)));
    const coverage = computeCoverage(analysis, context.snippets, pathTargets);
    const rankMs = Date.now() - t3;

    this.logger.debug('knowledge engine gathered evidence', {
      candidates: retrieval.hits.length,
      kept: context.snippets.length,
      grounded,
      sources: context.sources.length,
    });

    return {
      analysis,
      intent,
      expansion,
      retrievalQuery,
      context,
      candidates: retrieval.hits.length,
      discarded: retrieval.hits.length - context.snippets.length,
      grounded,
      codeFindings,
      coverage,
      pathTargets,
      sources: context.sources,
      timings: { analyze: analyzeMs, search: searchMs, rank: rankMs },
    };
  }

  /** Total time the engine spent, for the answer's timing report. */
  static elapsed(result: KnowledgeResult, startedAt: number): number {
    void result;
    return Date.now() - startedAt;
  }
}
