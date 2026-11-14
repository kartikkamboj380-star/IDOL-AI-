/**
 * Intent Detection Engine.
 *
 * Rule-based classification with explicit evidence, which is why the UI can
 * show "detected intent: how_to (matched: install, command)". No hidden model.
 */
import type { Intent, IntentResult } from '../../shared/types.js';
import { isCapabilityQuestion, isGreeting } from './question-analyzer.js';
import type { QuestionAnalysis } from '../../shared/types.js';

interface Rule {
  intent: Intent;
  patterns: RegExp[];
  keywords: string[];
  weight: number;
  shape: IntentResult['shape'];
}

const RULES: Rule[] = [
  {
    intent: 'code_explanation',
    patterns: [/\bwhat does (this|the) (code|function|file|class|method)\b/i, /\bexplain (this|the) (code|function|file|class|snippet)\b/i, /\bhow does .* (work|implement)\b/i],
    keywords: ['code', 'function', 'class', 'method', 'implementation', 'snippet', 'variable', 'return', 'import'],
    weight: 3,
    shape: 'code',
  },
  {
    intent: 'bug_analysis',
    patterns: [/\bwhy (is|does) .* (fail|crash|break|error)\b/i, /\b(fix|debug|diagnose)\b/i, /\bstack ?trace\b/i, /\bnot working\b/i],
    keywords: ['bug', 'error', 'exception', 'crash', 'fail', 'broken', 'issue', 'debug', 'traceback', 'undefined', 'null'],
    weight: 3,
    shape: 'bullets',
  },
  {
    intent: 'how_to',
    patterns: [/\bhow (do|can|should|to)\b/i, /\b(steps|instructions) (to|for)\b/i],
    keywords: ['install', 'setup', 'set up', 'run', 'usage', 'example', 'command', 'configure', 'start', 'quickstart'],
    weight: 2,
    shape: 'steps',
  },
  {
    intent: 'comparison',
    patterns: [/\b(compare|comparison|versus|-vs-|difference between)\b/i, /\bbetter than\b/i],
    keywords: ['vs', 'versus', 'compare', 'difference', 'differences', 'better', 'worse', 'tradeoff', 'trade-off'],
    weight: 3,
    shape: 'table',
  },
  {
    intent: 'summarization',
    patterns: [/^\s*(summar|tl;?dr|give me a summary|overview of)\w*/i, /\bsummar(y|ize|ise)\b/i],
    keywords: ['summary', 'summarize', 'summarise', 'overview', 'tl;dr', 'brief', 'outline', 'recap'],
    weight: 3,
    shape: 'bullets',
  },
  {
    intent: 'troubleshooting',
    patterns: [/\b(why|what) (is|does) .*(error|warning)\b/i, /\berror message\b/i, /\bkeeps? (failing|breaking)\b/i],
    keywords: ['troubleshoot', 'error', 'warning', 'stuck', 'permission', 'denied', 'timeout', 'oom', 'rate limit'],
    weight: 2,
    shape: 'bullets',
  },
  {
    intent: 'repo_overview',
    patterns: [/\bwhat is (this|the) (repo|repository|project)\b/i, /\b(overview|about) (of )?(this|the) (repo|repository|project)\b/i, /\bwhat does (this|the) (repo|repository|project) do\b/i],
    keywords: ['repo', 'repository', 'project', 'codebase', 'overview', 'structure', 'tree', 'files'],
    weight: 2,
    shape: 'prose',
  },
  {
    intent: 'documentation_search',
    patterns: [/\b(find|search|look for|where is|where can i find)\b/i, /\bdocs?\b/i, /\bdocumentation\b/i],
    keywords: ['documentation', 'docs', 'readme', 'guide', 'reference', 'find', 'search', 'where', 'locate'],
    weight: 2,
    shape: 'bullets',
  },
  {
    intent: 'factual_lookup',
    patterns: [/\bwhat (is|are|was|were)\b/i, /\bhow (many|much|long|big|fast)\b/i, /\bwhich\b/i, /\bwho\b/i],
    keywords: ['what', 'which', 'how', 'many', 'much', 'value', 'number', 'size', 'name', 'version', 'license'],
    weight: 1,
    shape: 'prose',
  },
];

export function detectIntent(analysis: QuestionAnalysis): IntentResult {
  const raw = analysis.raw;
  const normalized = analysis.normalized;

  if (isGreeting(normalized)) {
    return {
      intent: 'greeting',
      confidence: 0.98,
      evidence: ['greeting pattern'],
      shape: 'prose',
      wantsCode: false,
      wantsSources: false,
    };
  }
  if (isCapabilityQuestion(normalized)) {
    return {
      intent: 'capabilities',
      confidence: 0.95,
      evidence: ['capability question'],
      shape: 'bullets',
      wantsCode: false,
      wantsSources: false,
    };
  }

  const scores = new Map<Intent, { score: number; evidence: string[] }>();
  for (const rule of RULES) {
    const evidence: string[] = [];
    let score = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(raw)) {
        score += rule.weight;
        evidence.push(`pattern:${pattern.source.slice(0, 32)}`);
      }
    }
    const vocabulary = new Set([...analysis.terms, ...normalized.split(/\s+/)]);
    for (const keyword of rule.keywords) {
      if (keyword.includes(' ')) {
        if (normalized.includes(keyword)) {
          score += 0.6;
          evidence.push(`phrase:${keyword}`);
        }
      } else if (vocabulary.has(keyword)) {
        score += 0.5;
        evidence.push(`term:${keyword}`);
      }
    }
    if (score > 0) scores.set(rule.intent, { score, evidence });
  }

  let best: { intent: Intent; score: number; evidence: string[]; shape: IntentResult['shape'] } | null = null;
  for (const rule of RULES) {
    const entry = scores.get(rule.intent);
    if (!entry) continue;
    if (!best || entry.score > best.score) {
      best = { intent: rule.intent, score: entry.score, evidence: entry.evidence, shape: rule.shape };
    }
  }

  if (analysis.explicitPaths.length > 0 && (!best || best.score < 3)) {
    best = {
      intent: 'documentation_search',
      score: Math.max(best?.score ?? 0, 3),
      evidence: ['explicit file path'],
      shape: 'bullets',
    };
  }

  if (!best) {
    return {
      intent: 'factual_lookup',
      confidence: 0.3,
      evidence: ['fallback: no intent rule matched'],
      shape: 'prose',
      wantsCode: false,
      wantsSources: true,
    };
  }

  // Confidence is a bounded, explainable function of rule evidence, not a
  // calibrated model probability.
  const confidence = Math.min(0.95, 0.45 + best.score * 0.08);
  const wantsCode = best.intent === 'code_explanation' || best.intent === 'bug_analysis' || analysis.facets.includes('usage');
  return {
    intent: best.intent,
    confidence: Number(confidence.toFixed(2)),
    evidence: best.evidence.slice(0, 6),
    shape: best.shape,
    wantsCode,
    wantsSources: true,
  };
}

/** Intent must not override an honest refusal for non-knowledge chit-chat. */
export function isOutOfScope(analysis: QuestionAnalysis, corpusPassages: number): boolean {
  if (corpusPassages === 0) return true;
  if (analysis.terms.length > 0) return false;
  return analysis.raw.length > 0 && !isGreeting(analysis.normalized) && !isCapabilityQuestion(analysis.normalized);
}
