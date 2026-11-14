/**
 * Question Analyzer Engine.
 *
 * Turns a raw user message into a structured analysis: normalized text,
 * content terms, phrases, explicit file paths, code identifiers, facets that
 * hint at which part of a repository is relevant, and follow-up detection.
 *
 * This is deterministic NLP (tokenisation, stemming, heuristics) — it does not
 * perform semantic reasoning, and the UI never claims it does.
 */
import type { QuestionAnalysis } from '../../shared/types.js';
import { bigrams, contentTerms, normalizeText, stem, uniqueTerms } from '../knowledge/text.js';

const FOLLOW_UP_PATTERNS: RegExp[] = [
  /^(and|but|so|then|also|what about|how about|why|how so|more|elaborate|continue|go on)\b/i,
  /\b(it|its|that|this|those|these|they|them|there|the same|above|previous|earlier)\b/i,
  /^(explain|expand|clarify|simplify|summarize)\b[^.?!]{0,12}$/i,
  /^(another|one more|next)\b/i,
];

const FACET_TERMS: Record<string, string[]> = {
  install: ['install', 'setup', 'set up', 'getting started', 'quickstart', 'requirements', 'prerequisite', 'pip', 'npm', 'clone'],
  usage: ['usage', 'use', 'example', 'run', 'command', 'cli', 'api', 'sample', 'invoke'],
  architecture: ['architecture', 'design', 'structure', 'component', 'module', 'engine', 'pipeline', 'workflow'],
  benchmark: ['benchmark', 'performance', 'speed', 'latency', 'faster', 'gpu', 'vram', 'memory', 'time', 'compare'],
  config: ['config', 'configuration', 'setting', 'option', 'flag', 'parameter', 'environment variable', 'json'],
  model: ['model', 'weights', 'checkpoint', 'safetensors', 'parameters', 'encoder', 'decoder', 'denoiser'],
  license: ['license', 'licence', 'apache', 'mit', 'copyright', 'terms'],
  security: ['security', 'token', 'secret', 'auth', 'permission', 'private', 'vulnerability'],
  testing: ['test', 'testing', 'coverage', 'ci', 'workflow', 'pytest', 'jest'],
  deploy: ['deploy', 'deployment', 'host', 'docker', 'server', 'production', 'build'],
  data: ['dataset', 'data', 'gallery', 'asset', 'image', 'video', 'file'],
  troubleshooting: ['error', 'fail', 'fails', 'issue', 'problem', 'broken', 'crash', 'stuck', 'debug'],
};

const PATH_PATTERN = /(?:^|\s|`)((?:[\w.-]+\/)+[\w.-]+\.(?:md|mdx|ts|tsx|js|jsx|py|json|ya?ml|toml|txt|css|html|sh|safetensors|webp|mp4))(?:\s|`|$)/gi;
const IDENTIFIER_PATTERN = /`([^`\n]{2,64})`|\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b|\b(\w+\.[a-z]{2,6}(?:\s|$))/g;

export interface AnalyzeOptions {
  /** Previous conversation terms, used only to compute follow-up intent. */
  priorTerms?: string[];
}

export function analyzeQuestion(raw: string, options: AnalyzeOptions = {}): QuestionAnalysis {
  const trimmed = raw.trim();
  const normalized = normalizeText(trimmed);
  const { terms } = contentTerms(trimmed);
  const unique = [...new Set(terms)];
  const analysis: QuestionAnalysis = {
    raw: trimmed,
    normalized,
    terms: unique.slice(0, 40),
    phrases: bigrams(unique).slice(0, 24),
    explicitPaths: extractPaths(trimmed),
    identifiers: extractIdentifiers(trimmed),
    isFollowUp: false,
    retrievalQuery: trimmed,
    facets: detectFacets(normalized),
    language: /[a-z]/i.test(trimmed) ? 'en' : 'unknown',
  };

  // Overlap must be measured against the question's *own* terms, before memory
  // expansion merges earlier vocabulary into `terms`.
  analysis.isFollowUp = detectFollowUp(trimmed, unique, options.priorTerms ?? []);
  if (analysis.isFollowUp && (options.priorTerms?.length ?? 0) > 0) {
    const prior = options.priorTerms ?? [];
    const expanded = [...new Set([...unique, ...prior])];
    analysis.retrievalQuery = `${trimmed} ${expanded.join(' ')}`.trim();
    analysis.terms = expanded.slice(0, 48);
  }
  return analysis;
}

function detectFollowUp(raw: string, terms: string[], priorTerms: string[]): boolean {
  if (priorTerms.length === 0) return false;
  if (FOLLOW_UP_PATTERNS.some((pattern) => pattern.test(raw))) return true;
  const overlap = terms.filter((term) => priorTerms.includes(term)).length;
  // A question that repeats the conversation's own vocabulary is self-contained,
  // no matter how short it is ("benchmark results?" in a benchmark conversation).
  if (overlap >= 1) return false;
  if (terms.length === 0) return true;
  // Otherwise it must actually refer backwards to depend on the earlier turn.
  return /\b(it|its|that|this|they|them|those|these)\b/i.test(raw);
}

export function extractPaths(text: string): string[] {
  const out = new Set<string>();
  PATH_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_PATTERN.exec(text)) !== null) {
    const value = (match[1] ?? '').replace(/[.,;:]$/, '');
    if (value.length > 2) out.add(value);
  }
  return [...out].slice(0, 8);
}

export function extractIdentifiers(text: string): string[] {
  const out = new Set<string>();
  IDENTIFIER_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER_PATTERN.exec(text)) !== null) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (value.length < 3) continue;
    if (/^\d+$/.test(value)) continue;
    out.add(value);
  }
  return [...out].slice(0, 12);
}

/**
 * Terms that name a *file* rather than a topic ("readme", "changelog",
 * "package.json"). They are removed from content terms (so they do not act as
 * keywords) and used to filter the corpus instead.
 */
const FILE_TARGET_TERMS: Record<string, string[]> = {
  readme: ['readme'],
  changelog: ['changelog', 'changes', 'release-notes'],
  license: ['license', 'licence'],
  contributing: ['contributing'],
  docs: ['docs', 'documentation', 'guide'],
};

export function detectFileTargets(normalized: string): string[] {
  const targets: string[] = [];
  for (const [trigger, prefixes] of Object.entries(FILE_TARGET_TERMS)) {
    if (new RegExp(`\\b${trigger}s?\\b`).test(normalized)) targets.push(...prefixes);
  }
  return targets;
}

export function detectFacets(normalized: string): string[] {
  const facets: string[] = [];
  for (const [facet, keywords] of Object.entries(FACET_TERMS)) {
    if (keywords.some((keyword) => normalized.includes(keyword))) facets.push(facet);
  }
  return facets;
}

export function isGreeting(normalized: string): boolean {
  const trimmed = normalized.trim().replace(/[!.?,]+$/g, '');
  // Allow a short friendly tail ("hi there", "hello again", "hey idol").
  return /^(hi|hello|hey|yo|hiya|howdy|good (morning|afternoon|evening)|namaste|greetings)(\s+(there|again|idol|ai|friend|team)){0,2}$/i.test(
    trimmed,
  );
}

export function isCapabilityQuestion(normalized: string): boolean {
  return /\b(what can you do|who are you|what are you|your capabilities|how do you work|what is idol ai|help me get started|what can i ask)\b/.test(
    normalized,
  );
}

/** Terms from the last few user turns, used for memory expansion. */
export function memoryTermsFrom(history: Array<{ role: string; content: string }>, maxTurns = 4): string[] {
  const userTurns = history.filter((turn) => turn.role === 'user').slice(-maxTurns);
  const terms = userTurns.flatMap((turn) => uniqueTerms(turn.content)).map((term) => stem(term));
  const counts = new Map<string, number>();
  for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([term]) => term);
}
