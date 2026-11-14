/**
 * Syntax highlighting with per-language lazy registration.
 *
 * Only the highlighter core plus the languages we realistically encounter are
 * imported. Each language module is a small dynamic chunk, so the initial
 * payload stays lean and unknown languages simply render as plain text.
 */
import hljs from 'highlight.js/lib/core';
import { escapeHtml } from './escape.js';

type LanguageLoader = () => Promise<{ default: unknown }>;

const loaders: Record<string, LanguageLoader> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  json: () => import('highlight.js/lib/languages/json'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  bash: () => import('highlight.js/lib/languages/bash'),
  python: () => import('highlight.js/lib/languages/python'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  sql: () => import('highlight.js/lib/languages/sql'),
  rust: () => import('highlight.js/lib/languages/rust'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  c: () => import('highlight.js/lib/languages/c'),
  ini: () => import('highlight.js/lib/languages/ini'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  diff: () => import('highlight.js/lib/languages/diff'),
  plaintext: () => import('highlight.js/lib/languages/plaintext'),
};

const ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  zsh: 'bash',
  py: 'python',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  md: 'markdown',
  toml: 'ini',
  cfg: 'ini',
  ps1: 'bash',
  powershell: 'bash',
  text: 'plaintext',
  txt: 'plaintext',
  '' : 'plaintext',
};

const registered = new Set<string>();
const pending = new Map<string, Promise<void>>();

function normalize(language: string): string {
  const lowered = language.trim().toLowerCase();
  return ALIASES[lowered] ?? lowered;
}

async function ensureLanguage(language: string): Promise<boolean> {
  const name = normalize(language);
  if (!loaders[name]) return false;
  if (registered.has(name)) return true;
  const existing = pending.get(name);
  if (existing) {
    await existing;
    return registered.has(name);
  }
  const loader = loaders[name];
  if (!loader) return false;
  const promise = loader()
    .then((mod) => {
      hljs.registerLanguage(name, mod.default as never);
      registered.add(name);
    })
    .catch(() => {
      /* language failed to load: plain text fallback */
    });
  pending.set(name, promise);
  await promise;
  pending.delete(name);
  return registered.has(name);
}

/** Synchronous attempt: returns highlighted HTML, or null to use plain text. */
export function highlightCode(code: string, language: string): string | null {
  const name = normalize(language);
  if (registered.has(name)) {
    try {
      return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }
  // Kick off loading for the next render; show escaped text until then.
  void ensureLanguage(name).then((ok) => {
    if (ok) {
      // Re-highlight any blocks waiting for this language.
      for (const node of document.querySelectorAll<HTMLElement>(`[data-hljs-pending="${name}"]`)) {
        const raw = node.textContent ?? '';
        try {
          node.innerHTML = hljs.highlight(raw, { language: name, ignoreIllegals: true }).value;
          node.removeAttribute('data-hljs-pending');
        } catch {
          /* leave as text */
        }
      }
    }
  });
  return null;
}

/** Escapes source for safe insertion when highlighting is unavailable. */
export function plainCode(code: string): string {
  return escapeHtml(code);
}

/** Warms the languages used most often, after first paint. */
export function preloadCommonLanguages(): void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  const run = (): void => {
    void ensureLanguage('typescript');
    void ensureLanguage('javascript');
    void ensureLanguage('bash');
    void ensureLanguage('json');
    void ensureLanguage('markdown');
    void ensureLanguage('python');
  };
  if (typeof idle === 'function') idle(run);
  else window.setTimeout(run, 1200);
}
