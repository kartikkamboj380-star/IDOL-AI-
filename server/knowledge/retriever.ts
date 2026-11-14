/**
 * Lexical retrieval over the passage index.
 *
 * Scoring is BM25 (k1=1.4, b=0.72) over passage text plus:
 *   - field boosts for terms matched in headings and file paths
 *   - a verbatim phrase bonus for quoted queries
 *   - a small recency-independent path-depth prior (shallow docs win ties)
 *   - a penalty for code-only passages when the question is conceptual
 *
 * This is a search engine, not a language model. It finds passages; the answer
 * engine composes an answer from exactly what is returned here.
 */
import type { ChunkKind, SearchHit } from '../../shared/types.js';
import type { Passage, SourceIndex } from './indexer.js';
import { contentTerms, stem, tokenize } from './text.js';

export interface RetrievalOptions {
  topK: number;
  /** Restrict to these sources (empty = all). */
  sourceIds?: string[];
  /** Prefer markdown/docs over code when the question is conceptual. */
  preferDocs?: boolean;
  /** Extra terms from conversation memory, applied with lower weight. */
  memoryTerms?: string[];
  /** Curated query-expansion terms (related documentation vocabulary). */
  expansionTerms?: string[];
  /** Prefer code passages (code explanation / bug questions). */
  preferCode?: boolean;
  /** Restrict to files whose name/path matches one of these tokens. */
  pathTargets?: string[];
  /** Detected intent, used to seed overview anchors for descriptive questions. */
  intent?: string;
}

export interface RetrievalDiagnostics {
  candidatePassages: number;
  searchedTerms: string[];
  missingTerms: string[];
  matchedTerms: string[];
  perSource: Record<string, { passages: number; hits: number }>;
  idf: Record<string, number>;
}

export interface RetrievalResult {
  hits: Array<SearchHit & { passage: Passage }>;
  diagnostics: RetrievalDiagnostics;
  elapsedMs: number;
}

const K1 = 1.4;
const B = 0.72;

function idfFor(docFreq: number, totalDocs: number): number {
  // BM25+ style IDF, always positive.
  return Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
}

function pathDepth(path: string): number {
  return path.split('/').length - 1;
}

interface IndexedSource {
  index: SourceIndex;
  htmlUrlFor: (path: string) => string | null;
  sourceName: string;
}



/** Text that introduces an example question rather than answering one. */
const QUOTED_QUESTION = /(^|\n)\s*(you|ask|example|e\.g\.|for example|try|query|question|prompt)\b[^\n]{0,40}(:|\?)/;

/** True when a phrase reads like a question ("how much vram does this need"). */
const QUESTION_SHAPED = /\b(how|what|why|when|where|which|who|does|do|is|are|can)\b/;

/**
 * True when the passage contains the phrase inside something that looks like a
 * displayed example: a blockquote, a fenced code block, an inline code span, or a
 * quote character. Those are transcriptions of a question, not answers.
 */
function quotesQuestion(text: string): boolean {
  return /[`>"]|^\s*\|/.test(text) || /\?\s*(\n|$)/.test(text);
}

/**
 * True for IDOL AI's own documentation rather than the indexed project's.
 *
 * These are the root-level docs that ship with the application. They stay
 * searchable (a developer asking "how do I run the tests?" needs them) but are
 * down-weighted so that a question about the demo corpus is answered from the
 * corpus, not from our own marketing copy.
 */
export function isSelfDocumentation(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (/^(readme|architecture|limitations|contributing|changelog|license)\.md$/.test(lower)) return true;
  // Our own docs/ tree carries the same meta-content, so it gets the same prior.
  return /^docs\/(architecture|limitations|design|internals|api)\.md$/.test(lower);
}

export class Retriever {
  /**
   * When true, IDOL AI's own documentation ranks at full weight. Developers
   * working on the app set IDOL_INDEX_APP_SOURCES=1 and want that; end users
   * asking about their own repository do not.
   */
  private readonly includeSelfDocsAtFullWeight = process.env.IDOL_INDEX_APP_SOURCES === '1';

  constructor(private readonly getSources: () => IndexedSource[]) {}

  /**
   * Retrieves the best passages for a query across all ready source indexes.
   */
  retrieve(query: string, options: RetrievalOptions): RetrievalResult {
    const started = Date.now();
    const sources = this.getSources().filter(
      (source) => !options.sourceIds || options.sourceIds.length === 0 || options.sourceIds.includes(source.index.sourceId),
    );
    const queryTerms = contentTerms(query);
    const termSet = new Set(queryTerms.terms);
    const originalTerms = new Set(queryTerms.terms);
    for (const extra of options.memoryTerms ?? []) {
      const stemmed = stem(extra);
      if (stemmed.length > 1) termSet.add(stemmed);
    }
    const expansionSet = new Set<string>();
    for (const extra of options.expansionTerms ?? []) {
      const stemmed = stem(extra);
      if (stemmed.length > 1 && !originalTerms.has(stemmed)) {
        termSet.add(stemmed);
        expansionSet.add(stemmed);
      }
    }
    const searchedTerms = [...termSet];
    const normalizedPhrase = query.toLowerCase().replace(/\s+/g, ' ').trim();
    const quoted = /"([^"]{3,})"/.exec(query)?.[1]?.toLowerCase();

    interface Scored {
      passage: Passage;
      score: number;
      signals: Record<string, number>;
      source: IndexedSource;
    }

    const scored: Scored[] = [];
    let candidatePassages = 0;
    const perSource: Record<string, { passages: number; hits: number }> = {};
    const idf: Record<string, number> = {};
    const matchedTerms = new Set<string>();

    // Overview-style questions ("what is this project?", "summarise the repo")
    // are answered by a README's opening description, whose words rarely match
    // the question. For those intents, seed each README's opening passage as an
    // anchor hit so the composer always has the descriptive evidence available.
    const seedAnchors =
      options.intent === 'repo_overview' ||
      options.intent === 'summarization' ||
      /\b(about|overview|summary|summarize|summarise|purpose|what is this|what does (this|it)\b)/i.test(query);
    if (seedAnchors) {
      for (const source of sources) {
        const readme = source.index.files
          .filter((file) => /(^|\/)readme\.md$/i.test(file.path) && file.passageIds.length > 0)
          .sort((a, b) => pathDepth(a.path) - pathDepth(b.path))[0];
        if (!readme) continue;
        const opening = readme.passageIds
          .map((id) => source.index.passages.find((passage) => passage.id === id))
          .find((passage) => passage && passage.kind === 'markdown');
        if (!opening) continue;
        // The corpus a user came to ask about should win the anchor slot over
        // IDOL AI's own README, which also describes this repository.
        const selfDoc = isSelfDocumentation(opening.path) && !this.includeSelfDocsAtFullWeight;
        scored.push({
          passage: opening,
          score: selfDoc ? 8 : 12.5,
          signals: selfDoc ? { anchor: 1, selfDoc: 0.64 } : { anchor: 1 },
          source,
        });
        matchedTerms.add('readme-anchor');
      }
    }

    for (const source of sources) {
      const index = source.index;
      const totalDocs = index.passages.length;
      candidatePassages += totalDocs;
      perSource[source.index.sourceId] = { passages: totalDocs, hits: 0 };
      if (totalDocs === 0) continue;

      const termIdf = new Map<string, number>();
      for (const term of termSet) {
        const df = index.docFreq[term] ?? 0;
        if (df === 0) continue;
        termIdf.set(term, idfFor(df, totalDocs));
        idf[term] = Math.max(idf[term] ?? 0, termIdf.get(term) as number);
        matchedTerms.add(term);
      }
      if (options.pathTargets && options.pathTargets.length > 0 && termIdf.size <= 1) {
        // No keyword signal, but the user named a file ("summarise the README").
        // Return that file's leading passages in document order.
        const targeted = index.passages.filter((passage) =>
          options.pathTargets?.some((target) => passage.path.toLowerCase().includes(target)),
        );
        const termList = [...termSet];
        const docScore = (passage: Passage): number => {
          const haystack = passage.text.toLowerCase();
          const hits = termList.filter((term) => haystack.includes(term)).length;
          // A whole-document request wants the opening/overview sections, so
          // document order is a first-class signal here, ahead of term hits.
          return hits * 2;
        };
        const ordered = targeted
          .slice()
          .sort((a, b) => {
            const aReadme = a.path.toLowerCase().split('/').pop()?.startsWith('readme') ? 1 : 0;
            const bReadme = b.path.toLowerCase().split('/').pop()?.startsWith('readme') ? 1 : 0;
            if (aReadme !== bReadme) return bReadme - aReadme;
            const aDepth = pathDepth(a.path);
            const bDepth = pathDepth(b.path);
            if (aDepth !== bDepth) return aDepth - bDepth;
            const scoreDiff = docScore(b) - docScore(a);
            if (scoreDiff !== 0) return scoreDiff;
            return a.startLine - b.startLine;
          })
          .slice(0, Math.max(3, options.topK));
        for (const [order, passage] of ordered.entries()) {
          const syntheticScore = 14 - order * 0.35;
          scored.push({
            passage,
            score: syntheticScore,
            signals: { pathTarget: 1, documentOrder: order },
            source,
          });
        }
        if (ordered.length > 0) matchedTerms.add('path-target');
        continue;
      }
      if (termIdf.size === 0) continue;

      // Accumulate per-passage BM25 contributions from postings.
      const scores = new Map<number, number>();
      const matchedPerPassage = new Map<number, number>();
      for (const [term, termIdfValueRaw] of termIdf) {
        const postings = index.postings[term];
        if (!postings) continue;
        const termIdfValue = expansionSet.has(term) ? termIdfValueRaw * 0.45 : termIdfValueRaw;
        for (const posting of postings) {
          const passage = index.passages[posting.p];
          if (!passage) continue;
          const norm = posting.t + K1 * (1 - B + B * (passage.length / Math.max(1, index.avgLength)));
          const termScore = termIdfValue * ((posting.t * (K1 + 1)) / Math.max(1e-6, norm));
          const boosted = termScore * (1 + 0.35 * posting.f);
          scores.set(posting.p, (scores.get(posting.p) ?? 0) + boosted);
          matchedPerPassage.set(posting.p, (matchedPerPassage.get(posting.p) ?? 0) + 1);
        }
      }

      // Memory-only terms (not in this index) contribute a small direct-match bonus.
      const memoryOnly = (options.memoryTerms ?? []).map((term) => stem(term)).filter((term) => !termIdf.has(term));

      for (const [passageIndex, baseScore] of scores) {
        const passage = index.passages[passageIndex];
        if (!passage) continue;
        if (options.pathTargets && options.pathTargets.length > 0) {
          const lowerPath = passage.path.toLowerCase();
          if (!options.pathTargets.some((target) => lowerPath.includes(target))) continue;
        }
        const signals: Record<string, number> = { bm25: Number(baseScore.toFixed(4)) };
        let score = baseScore;

        // IDOL AI's own meta-documentation (README/ARCHITECTURE/LIMITATIONS at the
        // repository root, or any docs/ page) describes *how the tool works*. It
        // must stay searchable — "how do I run the tests?" is a real question —
        // but it should not outrank the corpus a user actually came to ask about,
        // so it carries a modest prior. Opt in to full weight with
        // IDOL_INDEX_APP_SOURCES=1, which is what developers debugging the app want.
        if (!this.includeSelfDocsAtFullWeight && isSelfDocumentation(passage.path)) {
          // Strong prior, not a light one: meta-documentation describes the tool,
          // and its marketing prose is dense with the same vocabulary a user asks
          // about. 0.35 keeps it available for genuine "how does IDOL work?"
          // questions without letting it beat the corpus being asked about.
          score *= 0.35;
          signals.selfDoc = 0.35;
        }

        const lowerText = passage.text.toLowerCase();
        if (quoted && lowerText.includes(quoted) && passage.kind !== 'code') {
          score *= 1.5;
          signals.phrase = 1.5;
        }
        const matchedCount = matchedPerPassage.get(passageIndex) ?? 0;
        const coverage = matchedCount / Math.max(1, termIdf.size);
        const originalCoverage =
          [...termIdf.keys()].filter((term) => originalTerms.has(term)).length === 0
            ? 0
            : [...matchedPerPassage.keys()].length > 0
              ? matchedCount / Math.max(1, [...termIdf.keys()].filter((term) => originalTerms.has(term)).length)
              : 0;
        signals.originalCoverage = Number(originalCoverage.toFixed(3));
        signals.coverage = Number(coverage.toFixed(3));
        score *= 0.75 + 0.55 * coverage;

        if (memoryOnly.length > 0) {
          let memoryHits = 0;
          for (const term of memoryOnly) if (lowerText.includes(term)) memoryHits += 1;
          if (memoryHits > 0) {
            const bonus = Math.min(1.25, 1 + 0.18 * memoryHits);
            score *= bonus;
            signals.memory = Number(bonus.toFixed(3));
          }
        }

        const headingText = `${passage.headingPath.join(' ')} ${passage.heading ?? ''}`.toLowerCase();
        if (headingText && [...termSet].some((term) => headingText.includes(term))) {
          score *= 1.18;
          signals.heading = 1.18;
        }
        const pathLower = passage.path.toLowerCase();
        if ([...termSet].some((term) => term.length > 3 && pathLower.includes(term))) {
          score *= 1.12;
          signals.path = 1.12;
        }

        if (passage.docWeight !== undefined) {
          score *= passage.docWeight;
          signals.docWeight = Number(passage.docWeight.toFixed(2));
        }

        // Code-literal penalty: source files full of quoted UI strings can match
        // user questions verbatim. That is code, not documentation.
        if (passage.kind === 'code') {
          const quotedChars = (passage.text.match(/(['"`])(?:\\.|(?!\1).){4,}\1/g) ?? []).reduce(
            (sum, literal) => sum + literal.length,
            0,
          );
          const ratio = quotedChars / Math.max(1, passage.text.length);
          if (ratio > 0.22) {
            const penalty = Math.max(0.35, 1 - (ratio - 0.22) * 1.8);
            score *= penalty;
            signals.codeLiteralPenalty = Number(penalty.toFixed(3));
          }
        }

        // Echo penalty: a passage that repeats the user's question almost
        // verbatim is usually the UI string that suggested it, not an answer.
        const overlapRatio = matchedCount / Math.max(1, [...new Set(contentTerms(passage.text).terms)].length);
        if (matchedCount >= 3 && overlapRatio > 0.55 && passage.length < 260) {
          score *= 0.45;
          signals.echoPenalty = 0.45;
        }

        const depth = pathDepth(passage.path);
        const depthBoost = 1 + Math.max(0, 0.05 - depth * 0.012);
        score *= depthBoost;
        signals.depth = Number(depthBoost.toFixed(3));

        if (options.preferDocs) {
          const kindBoost =
            passage.kind === 'markdown' ? 1.3 : passage.kind === 'code' ? 0.75 : passage.kind === 'data' ? 0.85 : 1;
          score *= kindBoost;
          signals.kind = kindBoost;
          // Implementation code is full of domain vocabulary (variable names,
          // comments, sample strings). For a documentation question that is
          // usually noise, so it must clear a higher bar than prose.
          if (passage.kind === 'code' && !passageIsDocComment(passage)) {
            score *= 0.55;
            signals.codePenalty = 0.55;
          }
          // Structured data files (JSON/TOML/YAML) match keywords but rarely
          // answer a documentation question; they need a much stronger signal.
          if (passage.kind === 'data') {
            score *= 0.5;
            signals.dataPenalty = 0.5;
          }
        } else if (options.preferCode) {
          const kindBoost = passage.kind === 'code' ? 1.25 : passage.kind === 'data' ? 1.05 : 1;
          score *= kindBoost;
          signals.kind = kindBoost;
        }

        // A verbatim phrase match is strong evidence in prose, but it is *not*
        // evidence when the passage is quoting a question rather than answering
        // one: documentation that shows "how do I install this?" as an example
        // query, or a test fixture containing the question, would otherwise
        // outrank the page that actually explains the answer.
        if (normalizedPhrase.length > 8 && lowerText.includes(normalizedPhrase)) {
          const quoting = QUOTED_QUESTION.test(lowerText) || QUESTION_SHAPED.test(normalizedPhrase) && quotesQuestion(lowerText);
          if (quoting) {
            signals.exactPhrase = 1;
          } else {
            const bonus = passage.kind === 'code' ? 1.05 : 1.6;
            score *= bonus;
            signals.exactPhrase = bonus;
          }
        }

        scored.push({ passage, score, signals, source });
      }
    }

    scored.sort((a, b) => b.score - a.score);

    // De-duplicate near-identical snippets while keeping the best of each path.
    const perPath = new Map<string, number>();
    const selected: Scored[] = [];
    const seenRanges = new Set<string>();
    const seenContent = new Map<string, Scored>();
    for (const item of scored) {
      if (selected.length >= options.topK) break;
      // The same file indexed from GitHub and a local checkout must not be
      // cited twice. Keep the higher-scoring copy of identical content.
      const contentKey = `${item.passage.path}:${item.passage.startLine}:${item.passage.endLine}`;
      const existing = seenContent.get(contentKey);
      if (existing) continue;
      seenContent.set(contentKey, item);
      const key = `${item.passage.sourceId}:${item.passage.path}`;
      const count = perPath.get(key) ?? 0;
      if (count >= 2) continue;
      const rangeKey = `${key}:${Math.floor(item.passage.startLine / 12)}`;
      if (seenRanges.has(rangeKey)) continue;
      seenRanges.add(rangeKey);
      perPath.set(key, count + 1);
      selected.push(item);
      const stats = perSource[item.passage.sourceId];
      if (stats) stats.hits += 1;
    }

    const hits = selected.map((item, index) => {
      const passage = item.passage;
      const excerpt = makeExcerpt(passage.text, [...termSet]);
      return {
        chunkId: passage.id,
        sourceId: passage.sourceId,
        path: passage.path,
        heading: passage.heading,
        startLine: passage.startLine,
        endLine: passage.endLine,
        score: Number(item.score.toFixed(4)),
        signals: item.signals,
        excerpt,
        kind: passage.kind as ChunkKind,
        language: passage.language,
        htmlUrl: item.source.htmlUrlFor(passage.path),
        passage,
        rank: index + 1,
      };
    });

    const diagnostics: RetrievalDiagnostics = {
      candidatePassages,
      searchedTerms,
      missingTerms: searchedTerms.filter((term) => !matchedTerms.has(term)),
      matchedTerms: [...matchedTerms],
      perSource,
      idf,
    };

    return { hits, diagnostics, elapsedMs: Date.now() - started };
  }

  /** Total passages available (used for "insufficient knowledge" decisions). */
  corpusSize(): number {
    return this.getSources().reduce((sum, source) => sum + source.index.passages.length, 0);
  }
}

/** True when a code passage is mostly a doc comment with no real code. */
function passageIsDocComment(passage: Passage): boolean {
  const lines = passage.text.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  const commentLines = lines.filter((line) => /^\s*(\/\/|\/\*|\*|#|--|;)/.test(line)).length;
  return commentLines / lines.length > 0.75;
}

/** Builds a compact excerpt centred on the best-matching line. */
export function makeExcerpt(text: string, terms: readonly string[], maxChars = 320): string {
  const clean = text.replace(/\s+\n/g, '\n').trim();
  if (clean.length <= maxChars) return clean;
  const lines = clean.split('\n');
  const lowered = terms.map((term) => term.toLowerCase());
  let bestLine = 0;
  let bestScore = -1;
  lines.forEach((line, index) => {
    const lower = line.toLowerCase();
    let score = 0;
    for (const term of lowered) if (term && lower.includes(term)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  });
  const center = lines[bestLine] ?? lines[0] ?? '';
  const before: string[] = [];
  const after: string[] = [];
  let budget = Math.max(40, maxChars - center.length);
  for (let i = bestLine - 1; i >= 0 && budget > 0; i -= 1) {
    const line = lines[i] ?? '';
    if (line.length + 1 > budget) break;
    before.unshift(line);
    budget -= line.length + 1;
  }
  for (let i = bestLine + 1; i < lines.length && budget > 0; i += 1) {
    const line = lines[i] ?? '';
    if (line.length + 1 > budget) break;
    after.push(line);
    budget -= line.length + 1;
  }
  const snippet = [...before, center, ...after].join('\n').trim();
  const prefix = before.length > 0 ? '…' : '';
  const suffix = after.length > 0 || before.length > 0 ? '…' : '';
  return `${prefix}${snippet.slice(0, maxChars)}${suffix}`;
}

/** Terms present in the corpus (for query suggestions / coverage display). */
export function corpusVocabulary(indexes: SourceIndex[], limit = 200): string[] {
  const counts = new Map<string, number>();
  for (const index of indexes) {
    for (const [term, df] of Object.entries(index.docFreq)) {
      if (tokenize(term).length === 0) continue;
      counts.set(term, (counts.get(term) ?? 0) + df);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term]) => term);
}
