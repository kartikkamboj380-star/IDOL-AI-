/**
 * Code Analysis Engine.
 *
 * Static, language-agnostic observations over retrieved code passages:
 * symbols, control-flow complexity, risk patterns (hardcoded secrets, eval,
 * TODO markers, unsafe shell calls), and imports. Findings quote a real line
 * range from the index, so nothing here is invented.
 */
import type { CodeFinding } from '../../shared/types.js';
import type { Passage } from '../knowledge/indexer.js';

interface RiskRule {
  id: string;
  pattern: RegExp;
  severity: CodeFinding['severity'];
  message: string;
  languages?: string[];
}

const RISK_RULES: RiskRule[] = [
  { id: 'secret', pattern: /\b(api[_-]?key|secret|password|passwd|token)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i, severity: 'high', message: 'Possible hardcoded credential — move it to an environment variable.' },
  { id: 'eval', pattern: /\beval\s*\(|new\s+Function\s*\(/, severity: 'high', message: 'Dynamic code execution (eval / Function) — review for injection risk.' },
  { id: 'inner-html', pattern: /\.innerHTML\s*=|dangerouslySetInnerHTML/, severity: 'medium', message: 'Unsanitised HTML insertion can enable XSS if the data is user controlled.' },
  { id: 'shell', pattern: /\b(exec|execSync|spawn)\s*\(\s*[`'"]|subprocess\.(run|call|Popen)\([^)]*shell\s*=\s*True|os\.system\(/, severity: 'medium', message: 'Shell execution — ensure arguments are not built from untrusted input.' },
  { id: 'sql', pattern: /(SELECT|INSERT|UPDATE|DELETE)[^;'"`]{0,80}(\+|\$\{|%s)/i, severity: 'high', message: 'String-built SQL — use parameterised queries.' },
  { id: 'http', pattern: /http:\/\/(?!localhost|127\.0\.0\.1)/, severity: 'low', message: 'Plain HTTP URL — prefer HTTPS for external calls.' },
  { id: 'todo', pattern: /\b(TODO|FIXME|HACK|XXX)\b/, severity: 'low', message: 'Unfinished-work marker found in the code.' },
  { id: 'empty-catch', pattern: /catch\s*(\([^)]*\))?\s*\{\s*\}/, severity: 'medium', message: 'Empty catch block silently swallows errors.' },
  { id: 'any', pattern: /:\s*any\b|<any>/, severity: 'low', message: 'TypeScript `any` disables type checking at this point.', languages: ['typescript', 'tsx'] },
  { id: 'console', pattern: /console\.(log|debug)\(/, severity: 'info', message: 'Debug logging left in the code path.', languages: ['typescript', 'tsx', 'javascript', 'jsx'] },
  { id: 'synchronous-io', pattern: /\b(readFileSync|writeFileSync|execSync)\b/, severity: 'low', message: 'Synchronous I/O blocks the event loop.', languages: ['typescript', 'tsx', 'javascript', 'jsx'] },
  { id: 'unsafe-random', pattern: /Math\.random\(\).*(token|secret|id|password)/i, severity: 'medium', message: 'Math.random is not cryptographically secure — use crypto.randomUUID/randomBytes.' },
];

const COMPLEXITY_TOKENS = /\b(if|else if|for|while|case|catch|switch)\b|\?\.|\?\?|&&|\|\|/g;

export interface ParsedSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'const' | 'method' | 'def' | 'export';
  line: number;
}

const SYMBOL_PATTERNS: Array<{ kind: ParsedSymbol['kind']; pattern: RegExp }> = [
  { kind: 'class', pattern: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'interface', pattern: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'type', pattern: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'function', pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
  { kind: 'def', pattern: /^\s*def\s+([A-Za-z_]\w*)/ },
  { kind: 'const', pattern: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/ },
  { kind: 'method', pattern: /^\s*(?:public\s+|private\s+|protected\s+|static\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
];

export function extractSymbols(text: string): ParsedSymbol[] {
  const symbols: ParsedSymbol[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.includes('//') && line.indexOf('//') < 3) continue;
    for (const { kind, pattern } of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      const name = match?.[1];
      if (!name) continue;
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function'].includes(name)) continue;
      const key = `${kind}:${name}`;
      if (seen.has(key)) break;
      seen.add(key);
      symbols.push({ name, kind, line: index + 1 });
      break;
    }
    if (symbols.length >= 40) break;
  }
  return symbols;
}

export function analyzePassage(passage: Passage): CodeFinding[] {
  if (passage.kind !== 'code') return [];
  const findings: CodeFinding[] = [];
  const lines = passage.text.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const rule of RISK_RULES) {
      if (rule.languages && !rule.languages.includes(passage.language)) continue;
      if (!rule.pattern.test(line)) continue;
      findings.push({
        path: passage.path,
        startLine: passage.startLine + index,
        endLine: passage.startLine + index,
        language: passage.language,
        category: rule.id === 'secret' || rule.id === 'eval' || rule.id === 'sql' ? 'risk' : 'pattern',
        severity: rule.severity,
        message: rule.message,
        excerpt: line.trim().slice(0, 180),
      });
      if (findings.length >= 14) break;
    }
    if (findings.length >= 14) break;
  }

  const tokens = passage.text.match(COMPLEXITY_TOKENS)?.length ?? 0;
  const depth = maxIndentDepth(lines, passage.language);
  if (tokens >= 18 || depth >= 6) {
    findings.push({
      path: passage.path,
      startLine: passage.startLine,
      endLine: passage.endLine,
      language: passage.language,
      category: 'complexity',
      severity: tokens >= 30 || depth >= 8 ? 'medium' : 'low',
      message: `Cyclomatic-ish signal: ${tokens} branch keyword(s), maximum indent depth ${depth}. Consider extracting helpers if this function grows.`,
      excerpt: lines.slice(0, 3).join('\n').trim().slice(0, 180),
    });
  }

  const symbols = extractSymbols(passage.text);
  if (symbols.length > 0) {
    findings.push({
      path: passage.path,
      startLine: passage.startLine,
      endLine: passage.endLine,
      language: passage.language,
      category: 'symbol',
      severity: 'info',
      message: `Defines ${symbols.length} symbol(s): ${symbols
        .slice(0, 8)
        .map((symbol) => `${symbol.name} (${symbol.kind})`)
        .join(', ')}${symbols.length > 8 ? ', …' : ''}.`,
      excerpt: symbols
        .slice(0, 4)
        .map((symbol) => `L${symbol.line}: ${symbol.kind} ${symbol.name}`)
        .join('\n'),
    });
  }

  const imports = extractImports(passage.text);
  if (imports.length > 0) {
    findings.push({
      path: passage.path,
      startLine: passage.startLine,
      endLine: passage.endLine,
      language: passage.language,
      category: 'dependency',
      severity: 'info',
      message: `Imports ${imports.length} module(s): ${imports.slice(0, 8).join(', ')}${imports.length > 8 ? ', …' : ''}.`,
      excerpt: imports.slice(0, 5).join('\n'),
    });
  }

  return findings;
}

function maxIndentDepth(lines: string[], language: string): number {
  const unit = language === 'python' ? 4 : 2;
  let max = 0;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indent = line.match(/^[ \t]*/)?.[0] ?? '';
    const width = indent.replace(/\t/g, '  '.repeat(unit / 2)).length;
    max = Math.max(max, Math.floor(width / unit));
  }
  return max;
}

export function extractImports(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /^\s*import\s+(?:[^'"]*from\s*)?['"]([^'"]+)['"]/gm,
    /^\s*from\s+([\w.]+)\s+import\b/gm,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*using\s+([\w.]+);/gm,
    /^\s*#include\s*[<"]([^>"]+)[>"]/gm,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1];
      if (value) out.add(value);
      if (out.size > 40) break;
    }
  }
  return [...out];
}

/** Aggregates findings, de-duplicating identical rule hits per file. */
export function aggregateFindings(findings: CodeFinding[]): CodeFinding[] {
  const seen = new Set<string>();
  const out: CodeFinding[] = [];
  const severityRank: Record<CodeFinding['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };
  for (const finding of findings.slice().sort((a, b) => severityRank[a.severity] - severityRank[b.severity])) {
    const key = `${finding.path}:${finding.startLine}:${finding.message.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
    if (out.length >= 12) break;
  }
  return out;
}
