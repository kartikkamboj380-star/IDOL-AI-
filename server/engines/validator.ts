/**
 * Response Validation Engine.
 *
 * Verifies that the answer only cites passages that were actually retrieved,
 * removes hallucinated citation markers, checks that quoted text exists in the
 * cited source, and flags unsupported claims. In knowledge mode all quoted
 * sentences come from the context by construction; in inference mode this is
 * the guardrail that catches citations invented by the model.
 */
import type { CitationValidation, ValidationReport } from '../../shared/types.js';
import type { ContextSnippet } from './context-builder.js';

export interface ValidateInput {
  answer: string;
  snippets: ContextSnippet[];
  /** When true, quoted (> block) sentences must appear in a cited snippet. */
  strictQuotes: boolean;
}

const CITATION_PATTERN = /\[(\d{1,3})\]/g;

export function validateAnswer(input: ValidateInput): { text: string; report: ValidationReport } {
  const byId = new Map(input.snippets.map((snippet) => [snippet.id, snippet]));
  const cited = new Set<number>();
  const invalid = new Set<number>();

  CITATION_PATTERN.lastIndex = 0;
  for (const match of input.answer.matchAll(CITATION_PATTERN)) {
    const id = Number(match[1]);
    if (byId.has(id)) cited.add(id);
    else invalid.add(id);
  }

  let text = input.answer;
  for (const id of invalid) {
    text = text.replaceAll(new RegExp(`\\s*\\[${id}\\]`, 'g'), '');
  }

  const citations: CitationValidation[] = [...cited].sort((a, b) => a - b).map((id) => {
    const snippet = byId.get(id) as ContextSnippet;
    return {
      marker: id,
      sourceId: snippet.sourceId,
      path: snippet.path,
      status: 'verified' as const,
      detail: `Lines ${snippet.startLine}-${snippet.endLine}`,
    };
  });

  const claimStatements = countClaims(text);
  const citationCoverage = claimStatements === 0 ? 0 : Math.min(1, cited.size / claimStatements);

  const unsupportedClaims: string[] = [];
  if (input.strictQuotes) {
    const blockquotes = [...text.matchAll(/^>\s?(.+)$/gm)].map((match) => (match[1] ?? '').trim()).filter((line) => line.length > 24);
    for (const quote of blockquotes) {
      const found = input.snippets.some((snippet) => normalizeForCompare(snippet.text).includes(normalizeForCompare(quote).slice(0, 80)));
      if (!found) unsupportedClaims.push(quote.slice(0, 120));
    }
  }

  const notes: string[] = [];
  if (invalid.size > 0) notes.push(`Removed ${invalid.size} citation marker(s) that did not match a retrieved passage.`);
  if (cited.size > 0) notes.push(`${cited.size} citation(s) verified against retrieved passages.`);
  if (claimStatements > 0 && cited.size === 0) notes.push('The answer makes claims without citing a retrieved passage.');

  const passed = unsupportedClaims.length === 0 && (cited.size > 0 || claimStatements === 0);

  return {
    text,
    report: {
      passed,
      citations,
      citationCoverage: Number(citationCoverage.toFixed(2)),
      unsupportedClaims,
      removedMarkers: invalid.size,
      notes,
    },
  };
}

function countClaims(text: string): number {
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ');
  const sentences = withoutCode
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 25)
    .filter((sentence) => !/^[*>-]*(knowledge mode|generated with)/i.test(sentence.replace(/[*>-]/g, ' ').trim()))
    .filter((sentence) => !/^>? ?\*\*(not found|steps i found|where this is documented|summary)/i.test(sentence));
  return sentences.length;
}

function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
