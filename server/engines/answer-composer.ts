/**
 * Answer Generation Engine — knowledge mode.
 *
 * Composes an answer **only from retrieved passages**. It is an extractive
 * summariser plus a Markdown assembler, not a language model: every factual
 * statement is either quoted from a cited passage or an explicit statement
 * about what the index does/does not contain.
 *
 * Structure is driven by the detected intent (steps, definition, table,
 * bullet summary, code walkthrough), and cosmetic markdown from the source
 * (bold labels, badges, HTML) is cleaned so the result renders reliably.
 */
import type { AnswerMode, IntentResult, MemoryState, QuestionAnalysis } from '../../shared/types.js';
import type { BuiltContext, ContextSnippet } from './context-builder.js';
import type { Passage } from '../knowledge/indexer.js';
import { normalizeText } from '../knowledge/text.js';
import {
  cleanProse,
  extractBullets,
  extractCodeBlocks,
  extractCommands,
  extractFacts,
  extractTables,
  tableCell,
  tidyHeading,
  toSentences,
} from './markdown-utils.js';

export interface ComposeInput {
  question: string;
  analysis: QuestionAnalysis;
  intent: IntentResult;
  memory: MemoryState;
  context: BuiltContext;
  hits: Array<{ passage: Passage; score: number }>;
  coverage: { matched: string[]; missing: string[] };
  corpus: { passages: number; files: number; sources: number };
  mode: AnswerMode;
  inferenceNote?: string;
}

export interface ComposeResult {
  text: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
}

const MAX_STEPS = 7;

export function composeKnowledgeAnswer(input: ComposeInput): ComposeResult {
  switch (input.intent.intent) {
    case 'greeting':
      return { text: greetingAnswer(input), confidence: 'high' };
    case 'capabilities':
      return { text: capabilityAnswer(input), confidence: 'high' };
    default:
      break;
  }
  if (input.context.snippets.length === 0) {
    return { text: noEvidenceAnswer(input), confidence: 'none' };
  }

  const sections: string[] = [];
  sections.push(leadSection(input));

  switch (input.intent.intent) {
    case 'how_to':
      sections.push(...howToSections(input));
      break;
    case 'code_explanation':
      sections.push(...codeSections(input));
      break;
    case 'bug_analysis':
    case 'troubleshooting':
      sections.push(...troubleshootingSections(input));
      break;
    case 'summarization':
      sections.push(...summarySections(input));
      break;
    case 'comparison':
      sections.push(...comparisonSections(input));
      break;
    case 'documentation_search':
      sections.push(...documentationSections(input));
      break;
    case 'repo_overview':
      sections.push(...overviewSections(input));
      break;
    default:
      sections.push(...detailSections(input));
  }

  const tables = extractTables(input.context.snippets.map((snippet) => snippet.text).join('\n\n'));
  if (tables.length > 0 && ['comparison', 'factual_lookup', 'documentation_search'].includes(input.intent.intent)) {
    const table = tables[0] as (typeof tables)[number];
    const owner = input.context.snippets.find((snippet) => snippet.text.includes(table.headers.join(' | ')) || snippet.text.includes(`| ${table.headers[0]}`));
    sections.push(renderTable(table, owner?.id ?? (input.context.snippets[0]?.id as number)));
  }

  const coverage = coverageNote(input);
  if (coverage) sections.push(coverage);
  sections.push(provenanceFooter(input));

  return {
    text: sections.filter((section) => section.trim().length > 0).join('\n\n'),
    confidence: scoreConfidence(input),
  };
}

/* ------------------------------------------------------------------ */
/* Lead + structural sections                                          */
/* ------------------------------------------------------------------ */

/** One or two clean, quoted sentences that directly address the question. */
function leadSection(input: ComposeInput): string {
  const ranked = proseSnippets(input);
  const top = ranked[0] ?? (input.context.snippets[0] as ContextSnippet);
  const isCode = top.kind === 'code';
  const sentences = isCode ? [] : pickBestSentences(top.text, input.analysis, 2);
  const location = `${top.path}${top.heading ? ` › ${top.heading}` : ''}`;
  if (sentences.length === 0) {
    return `The most relevant passage is **${location}** (lines ${top.startLine}–${top.endLine}) [${top.id}], but it contains code rather than prose — the excerpts below quote it exactly.`;
  }
  return `${sentences.join(' ')} [${top.id}]\n\n*Source: \`${location}\`, lines ${top.startLine}–${top.endLine}.*`;
}

function howToSections(input: ComposeInput): string[] {
  const sections: string[] = [];
  const commands = new Map<string, number>();
  for (const snippet of input.context.snippets) {
    for (const command of extractCommands(snippet.text)) commands.set(command, snippet.id);
  }
  if (commands.size > 0) {
    const lines = [...commands.entries()].slice(0, 8).map(([command, id]) => `${command}   # [${id}]`);
    sections.push(`**Commands from the source**\n\n\`\`\`bash\n${lines.join('\n')}\n\`\`\``);
  }

  const steps = buildSteps(input);
  if (steps.length > 0) {
    sections.push(`**Sequence described in the documentation**\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
  } else {
    const bullets = collectBullets(input, 5);
    if (bullets.length > 0) {
      sections.push(`**Key points that govern these instructions**\n\n${bullets.map((bullet) => `- ${bullet.text} [${bullet.id}]`).join('\n')}`);
    }
  }

  const constraints = collectConstraints(input, 3);
  if (constraints.length > 0) {
    sections.push(`**Requirements and caveats stated in the sources**\n\n${constraints.map((item) => `- ${item.text} [${item.id}]`).join('\n')}`);
  }
  return sections;
}

function buildSteps(input: ComposeInput): string[] {
  const steps: string[] = [];
  const seen = new Set<string>();
  for (const snippet of proseSnippets(input)) {
    // Numbered lists and bold step headings are the strongest step signal.
    const lines = snippet.text.split('\n');
    let inFence = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (/^```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const numbered = /^(\d+)[.)]\s+(.{10,260})$/.exec(line);
      const boldStep = /^\*\*(\d+[.)])?\s*([^*]{6,120})\*\*\s*$/.exec(line);
      const heading = /^#{2,4}\s+(.{4,120})$/.exec(line);
      let text: string | null = null;
      if (numbered?.[2]) text = numbered[2];
      else if (boldStep?.[2]) text = boldStep[2];
      else if (heading?.[1]) text = heading[1];
      if (!text) continue;
      const cleaned = stripInlineMarkup(text);
      if (cleaned.length < 8) continue;
      if (/^(examples?|get started|install|usage|flags|benchmark|across gpus|more details|faq|license|contents|table of contents)$/i.test(cleaned)) {
        continue;
      }
      if (/^name:/i.test(cleaned)) continue; // GitHub Actions step names are not user steps
      const key = cleaned.toLowerCase().slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      steps.push(`${cleaned} [${snippet.id}]`);
      if (steps.length >= MAX_STEPS) return steps;
      break; // one step per snippet keeps citations honest and varied
    }
  }
  return steps;
}

function codeSections(input: ComposeInput): string[] {
  const sections: string[] = [];
  const codeSnippets = input.context.snippets.filter((snippet) => snippet.kind === 'code');
  const shown = (codeSnippets.length > 0 ? codeSnippets : input.context.snippets).slice(0, 2);
  for (const snippet of shown) {
    const lines = snippet.text.split('\n').slice(0, 22);
    const start = snippet.startLine;
    const language = snippet.language || 'text';
    sections.push(
      `**\`${snippet.path}\` — lines ${start}–${start + lines.length - 1}** [${snippet.id}]\n\n\`\`\`${language}\n${lines.join('\n')}\n\`\`\``,
    );
  }
  const explained = codeSnippets[0] ?? input.context.snippets[0];
  if (explained) {
    const facts = extractFacts(explained.text).slice(0, 4);
    const commands = extractCommands(explained.text).slice(0, 3);
    const notes: string[] = [];
    for (const fact of facts) notes.push(`- **${fact.label}**: ${fact.value} [${explained.id}]`);
    for (const command of commands) notes.push(`- Runs \`${command}\` [${explained.id}]`);
    if (notes.length > 0) sections.push(`**What the retrieved code shows**\n\n${notes.join('\n')}`);
  }
  return sections;
}

function troubleshootingSections(input: ComposeInput): string[] {
  const sections: string[] = [];
  const warnings = collectConstraints(input, 5);
  if (warnings.length > 0) {
    sections.push(
      `**Constraints and failure conditions the sources state**\n\n${warnings.map((item) => `- ${item.text} [${item.id}]`).join('\n')}`,
    );
  }
  const commands = new Map<string, number>();
  for (const snippet of input.context.snippets) {
    for (const command of extractCommands(snippet.text)) commands.set(command, snippet.id);
  }
  if (commands.size > 0) {
    sections.push(
      `**Commands referenced in the relevant passages**\n\n\`\`\`bash\n${[...commands.entries()]
        .slice(0, 6)
        .map(([command, id]) => `${command}   # [${id}]`)
        .join('\n')}\n\`\`\``,
    );
  }
  if (sections.length === 0) return detailSections(input);
  return sections;
}

/** Heuristic: does this passage actually describe the project? */
function isDescriptionPassage(text: string): boolean {
  return /\b(turns?|is a|is an|provides?|generates?|enables?|allows?|built|designed (to|for)|aims? to)\b/i.test(text);
}

function summarySections(input: ComposeInput): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();
  // Put description-like passages first: a summary should open with what the
  // project is, not with its installation steps.
  const ordered = proseSnippets(input)
    .slice()
    .sort((a, b) => Number(isDescriptionPassage(b.text)) - Number(isDescriptionPassage(a.text)));
  for (const snippet of ordered) {
    const label = tidyHeading(snippet.heading ?? snippet.path.split('/').pop() ?? snippet.path);
    const sentence = pickBestSentences(snippet.text, input.analysis, 1)[0];
    const bullet = sentence ?? extractBullets(snippet.text)[0];
    if (!bullet) continue;
    const key = bullet.toLowerCase().slice(0, 48);
    if (seen.has(key)) continue;
    seen.add(key);
    bullets.push(`- **${label}** — ${bullet} [${snippet.id}]`);
    if (bullets.length >= 6) break;
  }
  if (bullets.length === 0) return detailSections(input);
  return [`**What the indexed sources say**\n\n${bullets.join('\n')}`];
}

function comparisonSections(input: ComposeInput): string[] {
  const rows: string[] = [];
  for (const snippet of proseSnippets(input).slice(0, 5)) {
    const statement = pickBestSentences(snippet.text, input.analysis, 1)[0] ?? extractBullets(snippet.text)[0];
    if (!statement) continue;
    rows.push(`| ${tableCell(statement)} | \`${snippet.path}\`${snippet.heading ? ` › ${tableCell(snippet.heading, 60)}` : ''} | [${snippet.id}] |`);
  }
  if (rows.length === 0) return detailSections(input);
  return [
    `**Passage-by-passage comparison**\n\n| Passage says | Location | Citation |\n|---|---|---|\n${rows.join('\n')}`,
    `This table only reports what each retrieved passage states. Any comparison the sources do not make is deliberately left out.`,
  ];
}

function documentationSections(input: ComposeInput): string[] {
  const bySource = new Map<string, ContextSnippet[]>();
  for (const snippet of proseSnippets(input)) {
    const list = bySource.get(snippet.sourceName) ?? [];
    list.push(snippet);
    bySource.set(snippet.sourceName, list);
  }
  const parts: string[] = [];
  for (const [sourceName, snippets] of bySource) {
    const items = snippets.slice(0, 6).map((snippet) => {
      const where = `${snippet.path}${snippet.heading ? ` › ${snippet.heading}` : ''}`;
      const gist = pickBestSentences(snippet.text, input.analysis, 1)[0];
      return `- \`${where}\` (lines ${snippet.startLine}–${snippet.endLine}) [${snippet.id}]${gist ? ` — ${gist}` : ''}`;
    });
    parts.push(`**${sourceName}**\n\n${items.join('\n')}`);
  }
  return [`**Where this appears**\n\n${parts.join('\n\n')}`];
}

function overviewSections(input: ComposeInput): string[] {
  const ranked = proseSnippets(input);
  const paragraphs: string[] = [];
  for (const snippet of ranked.slice(0, 3)) {
    const sentences = pickBestSentences(snippet.text, input.analysis, 2);
    if (sentences.length === 0) continue;
    paragraphs.push(`${sentences.join(' ')} [${snippet.id}]`);
  }
  const structure = ranked.slice(0, 6).map((snippet) => {
    const where = `\`${snippet.path}\`${snippet.heading ? ` › ${tidyHeading(snippet.heading)}` : ''}`;
    return `- ${where} — lines ${snippet.startLine}–${snippet.endLine} [${snippet.id}]`;
  });
  const bullets = collectBullets(input, 4);
  const parts: string[] = [];
  if (paragraphs.length > 0) parts.push(`**What the documentation says**\n\n${paragraphs.join('\n\n')}`);
  if (bullets.length > 0) parts.push(`**Highlights**\n\n${bullets.map((bullet) => `- ${bullet.text} [${bullet.id}]`).join('\n')}`);
  if (structure.length > 0) parts.push(`**Relevant passages**\n\n${structure.join('\n')}`);
  return parts;
}

function detailSections(input: ComposeInput): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();
  // Put description-like passages first: a summary should open with what the
  // project is, not with its installation steps.
  const ordered = proseSnippets(input)
    .slice()
    .sort((a, b) => Number(isDescriptionPassage(b.text)) - Number(isDescriptionPassage(a.text)));
  for (const snippet of ordered) {
    for (const sentence of pickBestSentences(snippet.text, input.analysis, 2)) {
      const key = sentence.toLowerCase().slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      bullets.push(`- ${sentence} [${snippet.id}]`);
      if (bullets.length >= 4) break;
    }
    if (bullets.length >= 4) break;
  }
  if (bullets.length > 0) return [`**What the sources say**\n\n${bullets.join('\n')}`];

  // Fallback 1: any prose paragraph at all, even if it does not match keywords.
  for (const snippet of input.context.snippets) {
    const paragraphs = cleanProse(snippet.text)
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 60);
    const paragraph = paragraphs[0];
    if (paragraph && !looksLikeData(paragraph)) {
      return [`**From \`${snippet.path}\`**${snippet.heading ? ` › ${snippet.heading}` : ''} [${snippet.id}]\n\n> ${paragraph}`];
    }
  }

  // Fallback 2: real code evidence, quoted exactly, never paraphrased.
  const codeSnippet = input.context.snippets.find((snippet) => snippet.kind === 'code') ?? input.context.snippets[0];
  if (!codeSnippet) return ['No usable passage was retrieved.'];
  return [
    `**Relevant excerpt from \`${codeSnippet.path}\`** [${codeSnippet.id}]\n\n\`\`\`${codeSnippet.language}\n${codeSnippet.text
      .split('\n')
      .slice(0, 16)
      .join('\n')}\n\`\`\``,
  ];
}

/* ------------------------------------------------------------------ */
/* Static responses                                                    */
/* ------------------------------------------------------------------ */

function greetingAnswer(input: ComposeInput): string {
  const corpus = input.corpus;
  const suggestions = [
    'What is this repository about?',
    'How do I install and run it?',
    'Summarise the README',
    'What are the hardware requirements?',
  ];
  return [
    `Hello — I'm **IDOL AI**. I answer questions using only the knowledge indexed in this workspace, and I cite the exact file, heading, and line range behind every claim.`,
    corpus.passages > 0
      ? `Right now I can search **${corpus.passages.toLocaleString()} passages** from **${corpus.files.toLocaleString()} files** across **${corpus.sources} source(s)**.`
      : `No knowledge source is indexed yet. Open **Sources** to index a repository, then ask me anything about it.`,
    `Some things to try:\n\n${suggestions.map((suggestion) => `- ${suggestion}`).join('\n')}`,
  ].join('\n\n');
}

function capabilityAnswer(input: ComposeInput): string {
  const can = [
    'Search every indexed file (docs, source code, config, notebooks) with BM25 ranking and field boosts',
    'Answer with exact citations — file path, heading, and line range for each claim',
    'Explain retrieved code and list static observations (symbols, imports, risky patterns)',
    'Summarise documents, compare passages, and walk through documented procedures',
    'Use earlier turns in the conversation when a follow-up question is vague',
    'Say "I could not find that" instead of inventing an answer',
  ];
  const cannot = [
    'Answer from general world knowledge outside the indexed repositories',
    'Claim a file was read when it was skipped (binaries, LFS pointers, oversized files)',
    'Behave like a large language model when no inference provider is configured',
  ];
  const modeLine =
    input.mode === 'inference'
      ? `**Current mode: inference.** Model answers are generated by \`${input.inferenceNote ?? 'the configured provider'}\` and grounded in retrieved passages; citations are validated before display.`
      : `**Current mode: knowledge.** Answers are composed by an extractive summariser over retrieved passages. No language model is used, so wording comes from your repository.`;
  return [
    `I'm **IDOL AI**, a retrieval-grounded assistant for repository knowledge.`,
    `${modeLine}\n\nIndexed corpus: **${input.corpus.passages.toLocaleString()} passages** from **${input.corpus.files.toLocaleString()} files** in **${input.corpus.sources} source(s)**.`,
    `**What I can do**\n\n${can.map((item) => `- ${item}`).join('\n')}`,
    `**What I cannot do**\n\n${cannot.map((item) => `- ${item}`).join('\n')}`,
  ].join('\n\n');
}

function noEvidenceAnswer(input: ComposeInput): string {
  const lines: string[] = [`I could not find anything in the indexed knowledge that answers this, so I won't guess.`];
  if (input.corpus.passages === 0) {
    lines.push('No knowledge source is indexed yet. Add a repository under **Sources** and index it first — there is nothing to search until then.');
  } else {
    const searched = input.coverage.missing.filter((term) => term.length > 4).slice(0, 5);
    lines.push(
      `I searched ${input.corpus.passages.toLocaleString()} passages across ${input.corpus.files.toLocaleString()} files${
        searched.length > 0 ? ` for ${searched.map((term) => `\`${term}\``).join(', ')}` : ''
      } and found no passage above the relevance threshold.`,
    );
  }
  lines.push(
    `**Ways to get an answer**\n\n- Rephrase using words that appear in the repository (file names, config keys, CLI flags)\n- Ask about a specific file, e.g. \`huggingface/speridlabs-idol/README.md\`\n- Add or re-index a source that covers the topic`,
  );
  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Ranks snippets by question-term overlap, with a strong prose preference for
 * documentation questions. Code passages stay available for code intents but
 * never masquerade as explanatory prose.
 */
function rankSnippetsForQuestion(input: ComposeInput): ContextSnippet[] {
  const terms = input.analysis.terms.filter((term) => term.length > 2);
  const codeIntent = input.intent.intent === 'code_explanation' || input.intent.intent === 'bug_analysis';
  return [...input.context.snippets]
    .filter((snippet) => !/^front matter$/i.test(snippet.heading ?? ''))
    .map((snippet) => {
      const haystack = normalizeText(`${snippet.heading ?? ''} ${snippet.text}`);
      const overlap = terms.filter((term) => haystack.includes(term)).length;
      const kindBonus = snippet.kind === 'code' ? (codeIntent ? 2 : -14) : snippet.kind === 'markdown' ? 6 : 0;
      return { snippet, rank: overlap * 10 + snippet.score / 10 + kindBonus };
    })
    .sort((a, b) => b.rank - a.rank)
    .map((entry) => entry.snippet);
}

/**
 * Prose snippets only. A passage indexed as markdown can still be a table row
 * or a config blob, so this also rejects passages that read like data.
 */
function proseSnippets(input: ComposeInput): ContextSnippet[] {
  return rankSnippetsForQuestion(input).filter(
    (snippet) => snippet.kind !== 'code' && snippet.kind !== 'data' && !looksLikeData(snippet.text),
  );
}

/** Heuristic: too much JSON/punctuation density means it is not prose. */
function looksLikeData(text: string): boolean {
  const trimmed = text.trim();
  if (/^[{[]/.test(trimmed)) return true;
  const tableRows = trimmed.split('\n').filter((line) => line.trim().startsWith('|')).length;
  const nonEmpty = trimmed.split('\n').filter((line) => line.trim().length > 0).length;
  if (nonEmpty > 0 && tableRows / nonEmpty > 0.6) return true;
  const punctuation = (trimmed.match(/[{}[\]":=<>;]/g) ?? []).length;
  return punctuation / Math.max(1, trimmed.length) > 0.07;
}

/** Sentence selection: term overlap first, position second, noise filtered. */
function pickBestSentences(text: string, analysis: QuestionAnalysis, count: number): string[] {
  const sentences = toSentences(text);
  if (sentences.length === 0) return [];
  const terms = analysis.terms.filter((term) => term.length > 2);
  const scored = sentences.map((sentence, index) => {
    const normalized = normalizeText(sentence);
    let score = 0;
    for (const term of terms) if (normalized.includes(term)) score += 1;
    if (/\b(is|are|means|refers to|requires?|supports?|includes?|allows?|generates?|removes?|runs?)\b/i.test(sentence)) score += 0.4;
    score += Math.max(0, 0.5 - index * 0.06);
    if (sentence.length > 420) score -= 0.5;
    if (/https?:\/\//.test(sentence)) score -= 0.3;
    return { sentence, score, index };
  });
  return scored
    .filter((entry) => entry.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.sentence);
}

function collectBullets(input: ComposeInput, limit: number): Array<{ text: string; id: number }> {
  const out: Array<{ text: string; id: number }> = [];
  const terms = input.analysis.terms.filter((term) => term.length > 2);
  for (const snippet of proseSnippets(input)) {
    for (const bullet of extractBullets(snippet.text)) {
      const normalized = normalizeText(bullet);
      const overlap = terms.filter((term) => normalized.includes(term)).length;
      if (overlap === 0 && out.length >= 2) continue;
      out.push({ text: bullet, id: snippet.id });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function collectConstraints(input: ComposeInput, limit: number): Array<{ text: string; id: number }> {
  const patterns = [
    /\b(requires?|required|must|only|needs?|prerequisites?|must be|before|note that|ensure|at least|maximum|minimum|not supported|does not|doesn't|cannot)\b/i,
    /\b(memory|vram|gpu|cuda|python|version|licen[cs]e|token|quota|limit)\b/i,
  ];
  const out: Array<{ text: string; id: number }> = [];
  const seen = new Set<string>();
  for (const snippet of proseSnippets(input)) {
    for (const sentence of toSentences(snippet.text)) {
      if (!patterns.some((pattern) => pattern.test(sentence))) continue;
      const key = sentence.toLowerCase().slice(0, 44);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: sentence, id: snippet.id });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function renderTable(table: { headers: string[]; rows: string[][]; caption: string | null }, citationId: number): string {
  const headers = table.headers.map((header) => tableCell(header, 40));
  const rows = table.rows.slice(0, 12).map((row) => {
    const cells: string[] = [];
    for (let index = 0; index < headers.length; index += 1) cells.push(tableCell(row[index] ?? '', 48));
    return `| ${cells.join(' | ')} |`;
  });
  const caption = table.caption ? `${table.caption} [${citationId}]\n\n` : '';
  return `**Table from the source** [${citationId}]\n\n${caption}| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n${rows.join('\n')}`;
}

function coverageNote(input: ComposeInput): string {
  const missing = input.coverage.missing.filter((term) => term.length > 3).slice(0, 6);
  if (missing.length === 0) return '';
  return `> **Not found in the indexed sources:** ${missing.map((term) => `\`${term}\``).join(', ')}. Those parts of the question were left unanswered rather than guessed.`;
}

function provenanceFooter(input: ComposeInput): string {
  if (input.mode === 'inference') {
    return `---\n\n*Generated by ${input.inferenceNote ?? 'the configured inference provider'}, grounded in ${input.context.snippets.length} retrieved passage(s). Every citation was checked against the retrieved text.*`;
  }
  return `---\n\n*Knowledge mode — extractive summary of ${input.context.snippets.length} retrieved passage(s). No language model was used; wording comes from the sources and citations are exact.*`;
}

function scoreConfidence(input: ComposeInput): 'high' | 'medium' | 'low' | 'none' {
  const top = input.context.snippets[0];
  if (!top) return 'none';
  const coverage = input.coverage.matched.length / Math.max(1, input.coverage.matched.length + input.coverage.missing.length);
  if (top.score > 8 && coverage > 0.55 && input.context.snippets.length >= 2) return 'high';
  if (top.score > 3.5 && coverage > 0.3) return 'medium';
  return 'low';
}

/** Removes bold/italic/code markers but keeps wording for inline sentences. */
function stripInlineMarkup(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Terms from the question that never appeared in retrieved passages. */
export function computeCoverage(
  analysis: QuestionAnalysis,
  snippets: ContextSnippet[],
  ignore: readonly string[] = [],
): { matched: string[]; missing: string[] } {
  const corpus = normalizeText(snippets.map((snippet) => snippet.text).join(' '));
  const matched: string[] = [];
  const missing: string[] = [];
  const ignored = new Set(ignore.map((term) => normalizeText(term)));
  for (const term of analysis.terms) {
    if (term.length < 3) continue;
    // Filename words ("readme") and request verbs ("summarise") are directives,
    // not facts to verify against the passages.
    if ([...ignored].some((entry) => entry.includes(term) || term.includes(entry))) continue;
    if (['summaris', 'summariz', 'summari', 'readm', 'changelog'].some((stop) => term.startsWith(stop))) continue;
    if (corpus.includes(term)) matched.push(term);
    else missing.push(term);
  }
  return { matched, missing: missing.sort((a, b) => b.length - a.length).slice(0, 8) };
}

export { extractCodeBlocks };
