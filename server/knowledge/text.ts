/**
 * Text normalisation and tokenisation shared by indexing and query analysis.
 * Deliberately simple and deterministic: this is a lexical retrieval engine,
 * not a neural embedding model, and it is reported as such.
 */

export const STOP_WORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor',
  'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out',
  'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too',
  'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who',
  'whom', 'why', 'will', 'with', 'would', 'you', 'your', 'yours', 'yourself', 'yourselves',
  // conversational filler that adds noise to retrieval
  'please', 'tell', 'explain', 'show', 'give', 'want', 'need', 'know', 'think', 'like', 'get', 'got',
  'also', 'much', 'many', 'really', 'actually', 'thing', 'things', 'stuff', 'kind', 'sort', 'maybe',
]);

const QUESTION_WORDS = new Set(['what', 'how', 'why', 'when', 'where', 'which', 'who', 'whom', 'whose']);

/** Words that signal a request for prose/help rather than a lookup. */
export const META_WORDS = new Set([
  'explain', 'summarize', 'summarise', 'summary', 'compare', 'difference', 'differences', 'versus', 'vs',
  'install', 'setup', 'configure', 'usage', 'use', 'example', 'examples', 'fix', 'error', 'bug', 'issue',
  'debug', 'why', 'how', 'guide', 'tutorial', 'overview', 'architecture', 'benchmark', 'performance',
]);

export function normalizeText(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9+#._\-\s/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Light stemmer: handles the plural/gerund forms that matter for retrieval. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 6) {
    const base = w.slice(0, -3);
    return base.endsWith(base[base.length - 1] as string) ? base.slice(0, -1) : base;
  }
  if (w.endsWith('ed') && w.length > 5) return w.slice(0, -2);
  if (w.endsWith('es') && w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) return w.slice(0, -1);
  return w;
}

/**
 * Tokenises text into index terms. Code-ish tokens keep underscores/dots so
 * identifiers such as `num_gaussians` or `idol.sample` remain searchable.
 */
export function tokenize(input: string): string[] {
  const normalized = input
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2');
  const raw = normalized.match(/[a-z0-9][a-z0-9_+\-./#]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  const out: string[] = [];
  for (const token of raw) {
    const cleaned = token.replace(/^[._/-]+|[._/-]+$/g, '');
    if (!cleaned) continue;
    if (cleaned.length > 64) {
      // Very long tokens (hashes, base64) are split into fixed windows.
      for (let i = 0; i + 24 <= cleaned.length && i < 96; i += 24) out.push(cleaned.slice(i, i + 24));
      continue;
    }
    out.push(cleaned);
  }
  return out;
}

export function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word);
}

export function isQuestionWord(word: string): boolean {
  return QUESTION_WORDS.has(word);
}

export interface TermVector {
  terms: string[];
  counts: Map<string, number>;
}

/** Produces stemmed, stop-word-filtered terms with repetition counts. */
export function contentTerms(text: string): TermVector {
  const counts = new Map<string, number>();
  const terms: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 2) continue;
    if (STOP_WORDS.has(token)) continue;
    const stemmed = stem(token);
    if (stemmed.length < 2) continue;
    terms.push(stemmed);
    counts.set(stemmed, (counts.get(stemmed) ?? 0) + 1);
  }
  return { terms, counts };
}

export function uniqueTerms(text: string): string[] {
  return [...new Set(contentTerms(text).terms)];
}

export function bigrams(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < terms.length; i += 1) out.push(`${terms[i]} ${terms[i + 1]}`);
  return out;
}

/** Splits camelCase / snake_case identifiers into their component words. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s./]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}
