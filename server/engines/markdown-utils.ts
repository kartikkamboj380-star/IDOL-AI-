/**
 * Markdown-aware text extraction used by the answer composer.
 *
 * Repository docs are full of markup: inline code, bold labels, tables, fenced
 * blocks, badges, HTML. When we quote a sentence we must not leak broken
 * `**` pairs, `<p align=...>` tags, or shield badges into the answer. These
 * helpers keep the prose and drop the scaffolding while preserving the words.
 */

const HTML_TAG = /<\/?[a-z][^>]*>/gi;
const BADGE_URL = /!\[[^\]]*\]\([^)]*\)/g;
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]+)\]\(([^)]+)\)/g;
const INLINE_CODE = /`([^`]+)`/g;

/** Removes HTML, badges, images, and collapses emphasis markers. */
export function cleanProse(input: string): string {
  let text = input;
  text = text.replace(/```[\s\S]*?```/g, ' '); // fenced code handled elsewhere
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(HTML_TAG, ' ');
  text = text.replace(BADGE_URL, ' ');
  text = text.replace(IMAGE, ' ');
  text = text.replace(LINK, (_match, label: string) => label);
  text = text.replace(INLINE_CODE, (_match, code: string) => code);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  text = text.replace(/__([^_\n]+)__/g, '$1');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/g, '$1$2');
  text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,:;!?]|$)/g, '$1$2');
  text = text.replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
  text = text.replace(/^\s{0,3}>\s?/gm, '');
  text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  text = text.replace(/\[[^\]]*\]\[\]/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  text = text.replace(/[ \t]{2,}/g, ' ');
  return text.trim();
}

/**
 * Splits text into sentences that survive basic markdown noise.
 *
 * Rules that matter in practice:
 *  - table rows, fenced code, and HTML never become sentences
 *  - list markers and bold labels are stripped, not quoted
 *  - newlines act as sentence boundaries, which stops heading fragments from
 *    being glued onto the next paragraph
 *  - version numbers and decimals survive
 */
export function toSentences(input: string): string[] {
  const withoutFences = input.replace(/```[\s\S]*?```/g, '\n');
  const lines = withoutFences.split('\n');
  const cleanedLines: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('|')) continue; // table rows are handled by extractTables
    if (/^<[/!a-z]/i.test(line)) continue; // raw HTML
    // Inline HTML with no prose (image/badge wrappers) is never quotable.
    if (/^<[^>]*>(\s*<[^>]*>)*\s*$/.test(line)) continue;
    if (/^(<a\s|<img\s|<div|<video|<p\s)/i.test(line)) continue;
    if (/^[=\-*_]{3,}$/.test(line)) continue; // horizontal rules
    if (/^\[!\[/.test(line)) continue; // badges
    cleanedLines.push(line);
  }
  // Markdown hard-wraps paragraphs at ~80 columns. Rejoin only genuine
  // continuations: never after a heading, bold label, list item, or table row.
  const reflowed: string[] = [];
  for (const line of cleanedLines) {
    const previous = reflowed[reflowed.length - 1];
    const startsNewBlock = /^([-*\u2022]|\d+[.)]|#{1,6}\s|>|\*\*|[A-Z][\w /-]{0,30}\*\*)/.test(line);
    const previousIsBlockEnd =
      previous === undefined ||
      /[.!?:;]$/.test(previous.trim()) ||
      /\*\*$/.test(previous.trim()) ||
      /^#{1,6}\s/.test(previous) ||
      /^[-*\u2022]/.test(previous) ||
      /^\d+[.)]/.test(previous) ||
      previous.trim().length < 20;
    const lineLooksLikeHeading =
      /^[A-Z][\w\s/-]{0,40}$/.test(line) && line.split(' ').length <= 6 && !/[a-z]{3,}\s[a-z]/.test(line);
    if (previous !== undefined && !startsNewBlock && !previousIsBlockEnd && !lineLooksLikeHeading) {
      reflowed[reflowed.length - 1] = `${previous} ${line}`;
    } else {
      reflowed.push(line);
    }
  }
  const text = reflowed
    .join('\n')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*\u2022]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(cleanProse('') /* no-op to keep helper referenced */, '');
  const prose = cleanProse(text);
  if (!prose) return [];
  const guarded = prose
    .replace(/(\d)\.(\d)/g, '$1\u0001$2')
    .replace(/\b([a-z])\.([a-z])\./gi, '$1\u0001$2\u0001')
    .replace(/\s*\n\s*/g, ' \u0002 ');
  const raw = guarded.split(/(?<=[.!?])\s+(?=[A-Z0-9(\["'`])|\u0002|(?<=[.!?])$/);
  return raw
    .map((sentence) => sentence.replace(/\u0001/g, '.').replace(/\u0002/g, ' ').replace(/\s{2,}/g, ' ').trim())
    // Drop fragments: text that starts mid-clause is not quotable evidence.
    .filter((sentence) => !/^[a-z]/.test(sentence))
    .filter((sentence) => !/[,(]$/.test(sentence))
    .filter((sentence) => (sentence.match(/\(/g)?.length ?? 0) <= (sentence.match(/\)/g)?.length ?? 0) + 1)
    .filter((sentence) => sentence.length >= 30)
    .filter((sentence) => (sentence.match(/[A-Za-z]{2,}/g)?.length ?? 0) >= 5)
    .filter((sentence) => /[.!?:]$/.test(sentence) || sentence.split(' ').length >= 6)
    .filter((sentence) => !/^(see|note|tip|warning|source|image|name)\s*:?\s*$/i.test(sentence));
}

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  caption: string | null;
}

/** Extracts GFM tables (the README has several that answer benchmark questions). */
export function extractTables(input: string): MarkdownTable[] {
  const lines = input.split('\n');
  const tables: MarkdownTable[] = [];
  let caption: string | null = null;
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headerLine = lines[index]?.trim() ?? '';
    const separatorLine = lines[index + 1]?.trim() ?? '';
    if (!headerLine.startsWith('|') || !/^\|?[\s:|-]+\|[\s:|-]*$/.test(separatorLine)) continue;
    const headers = splitRow(headerLine);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && (lines[cursor] ?? '').trim().startsWith('|')) {
      const row = splitRow(lines[cursor] as string);
      if (row.length > 0) rows.push(row);
      cursor += 1;
    }
    if (headers.length >= 2 && rows.length > 0) {
      // Look backwards for a nearby caption/lead sentence.
      const back = lines.slice(Math.max(0, index - 3), index).join(' ').trim();
      caption = back ? toSentences(back).slice(-1)[0] ?? null : null;
      tables.push({ headers, rows, caption });
      index = cursor - 1;
    }
  }
  return tables;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cleanProse(cell).replace(/\\\|/g, '|').trim());
}

/** Pulls fenced code blocks with their language, preserving exact content. */
export interface CodeBlock {
  language: string;
  code: string;
}

export function extractCodeBlocks(input: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const pattern = /```([\w+#.-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const code = (match[2] ?? '').replace(/\s+$/, '');
    if (code.trim().length === 0) continue;
    blocks.push({ language: (match[1] ?? '').trim(), code });
    if (blocks.length >= 12) break;
  }
  return blocks;
}

/** Extracts shell/CLI commands from fenced blocks and inline code. */
export function extractCommands(input: string): string[] {
  const commands: string[] = [];
  for (const block of extractCodeBlocks(input)) {
    const language = block.language.toLowerCase();
    if (!['', 'bash', 'sh', 'shell', 'console', 'zsh', 'powershell', 'ps1', 'cmd', 'python', 'py', 'yaml', 'yml'].includes(language)) {
      continue;
    }
    for (const line of block.code.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (language === 'yaml' || language === 'yml') continue;
      if (!/^(\$ )?(pip|pip3|npm|pnpm|yarn|npx|git|cd|python|python3|node|docker|curl|wget|uv|conda|export|hf|cargo|go|make|brew|apt|apt-get)\b/.test(trimmed)) {
        continue;
      }
      commands.push(trimmed.replace(/^\$\s+/, ''));
      if (commands.length >= 10) break;
    }
  }
  return [...new Set(commands)];
}

/**
 * Finds "label: value" style facts that answer direct questions
 * (e.g. "VRAM: 32 GB", "--steps default 50").
 */
export function extractFacts(input: string): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [];
  for (const line of input.split('\n')) {
    if (line.trim().startsWith('|')) continue;
    const bold = /^\s*(?:[-*]\s*)?\*\*([^*]{2,60}?)\*\*\s*[:—-]\s*(.{3,200})$/.exec(line);
    if (bold?.[1] && bold[2]) {
      facts.push({ label: cleanProse(bold[1]).replace(/:$/, ''), value: cleanProse(bold[2]) });
      continue;
    }
    const plain = /^\s*(?:[-*]\s*)?([A-Z][\w /().+-]{2,40}?)\s*[:\u2014]\s*(.{3,200})$/.exec(line);
    if (plain?.[1] && plain[2]) {
      const label = cleanProse(plain[1]);
      const value = cleanProse(plain[2]);
      if (label.length >= 3 && value.length >= 3 && !/^(http|https|image|name)$/i.test(label)) {
        facts.push({ label, value });
      }
    }
  }
  return facts.slice(0, 30);
}

/** Extracts bullet items, which are usually the most quotable part of a README. */
export function extractBullets(input: string): string[] {
  const bullets: string[] = [];
  let inFence = false;
  for (const rawLine of input.split('\n')) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^[-*\u2022]\s+(.{12,300})$/.exec(line);
    if (!match?.[1]) continue;
    const cleaned = cleanProse(match[1]);
    if (cleaned.length < 12) continue;
    if (/^(note|tip|warning)\b/i.test(cleaned)) continue;
    bullets.push(cleaned);
    if (bullets.length >= 12) break;
  }
  return bullets;
}

/** Escapes a cell for GFM table output. */
export function tableCell(value: string, maxChars = 120): string {
  const cleaned = cleanProse(value).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
  return cleaned.length > maxChars ? `${cleaned.slice(0, maxChars - 1)}…` : cleaned;
}

/** Normalises a heading for display ("get-started" → "Get started"). */
export function tidyHeading(heading: string): string {
  const cleaned = cleanProse(heading).replace(/^[#\s]+/, '').trim();
  return cleaned;
}
