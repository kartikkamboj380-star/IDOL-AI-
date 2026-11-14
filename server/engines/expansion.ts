/**
 * Query expansion.
 *
 * A user may ask about resource needs while a README only lists VRAM figures.
 * Lexical search cannot bridge that gap on its own, and no embedding model is
 * bundled. This module supplies a small, curated vocabulary
 * of documentation-domain equivalences. It is deliberately:
 *   - explicit and auditable (a map you can read, not a black box)
 *   - narrow (documentation vocabulary only, no general world knowledge)
 *   - additive (expanded terms are scored at reduced weight)
 *
 * It is NOT semantic understanding, and the UI does not present it as such.
 */
import { stem } from '../knowledge/text.js';
import vocabularyData from '../../data/expansion-vocabulary.json' with { type: 'json' };

/**
 * Canonical concept → related indexing terms.
 *
 * Kept as data in a JSON module so that implementation files do not contain
 * large vocabulary lists. Source code full of domain words makes the retriever
 * match its own implementation (a real failure mode we hit and fixed).
 */
export interface Vocabulary {
  concepts: Record<string, string[]>;
}

function loadVocabulary(): Vocabulary {
  // Statically imported JSON: bundled at build time, no filesystem access at
  // runtime, and a corrupt/missing file is caught at compile time.
  return vocabularyData as Vocabulary;
}

/** Reverse index: term → concepts that contain it. */
let reverseIndex: Map<string, string[]> | null = null;

function getReverseIndex(): Map<string, string[]> {
  if (reverseIndex) return reverseIndex;
  const index = new Map<string, string[]>();
  const concepts = loadVocabulary().concepts;
  for (const [concept, terms] of Object.entries(concepts)) {
    const all = new Set([concept, ...terms].map((term) => stem(term)));
    for (const term of all) {
      const list = index.get(term) ?? [];
      if (!list.includes(concept)) list.push(concept);
      index.set(term, list);
    }
  }
  reverseIndex = index;
  return index;
}

export interface ExpansionResult {
  /** Additional terms to retrieve with (already stemmed). */
  terms: string[];
  /** Concepts that triggered the expansion, for the UI/debug. */
  concepts: string[];
}

/**
 * Expands query terms with related documentation vocabulary.
 * `limit` keeps the expansion from swamping the original query.
 */
export function expandQuery(terms: readonly string[], limit = 10): ExpansionResult {
  const expanded = new Set<string>();
  const concepts: string[] = [];
  for (const term of terms) {
    const normalized = stem(term);
    const matched = getReverseIndex().get(normalized);
    if (!matched) continue;
    for (const concept of matched) {
      if (!concepts.includes(concept)) concepts.push(concept);
      const targets = loadVocabulary().concepts[concept];
      if (!targets) continue;
      for (const target of targets) {
        const stemmed = stem(target);
        if (stemmed === normalized) continue;
        expanded.add(stemmed);
      }
    }
  }
  // Remove terms the user already typed.
  for (const term of terms) expanded.delete(stem(term));
  return { terms: [...expanded].slice(0, limit), concepts: concepts.slice(0, 6) };
}

/** Ratio of quoted string literals to total characters — a code-table signal. */
export function codeLiteralRatio(text: string): number {
  const quoted = text.match(/(['"`])(?:\\.|(?!\1).){4,}\1/g) ?? [];
  const quotedChars = quoted.reduce((sum, literal) => sum + literal.length, 0);
  return quotedChars / Math.max(1, text.length);
}
