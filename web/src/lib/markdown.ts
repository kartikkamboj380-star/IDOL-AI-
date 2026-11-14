/**
 * Markdown rendering with sanitisation.
 *
 * Security model:
 *  1. marked parses Markdown to HTML (no raw HTML passthrough).
 *  2. DOMPurify sanitises the result with a strict allowlist.
 *  3. Citation markers [n] are only linked when n exists in the answer's
 *     sources, and only via data attributes — never via injected script.
 *
 * Highlighting happens after sanitisation, on text nodes we created ourselves.
 */
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { highlightCode } from './highlight.js';

export interface RenderOptions {
  /** Source ids that exist for this answer; used to validate [n] markers. */
  validCitations?: Set<number>;
  /** Called when a citation chip is clicked. */
  onCitationClick?: (id: number) => void;
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  pedantic: false,
});

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'a', 'span', 'sup', 'div',
];

const ALLOWED_ATTR = ['href', 'title', 'class', 'data-citation', 'data-lang', 'target', 'rel', 'aria-label'];

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') ?? '';
    // Only allow http(s) and in-page anchors: no javascript:, data:, vbscript:.
    const isSafe = /^https?:\/\//i.test(href) || href.startsWith('#') || href.startsWith('/');
    if (!isSafe) {
      node.removeAttribute('href');
      return;
    }
    if (/^https?:\/\//i.test(href)) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  }
});

export interface RenderedMarkdown {
  html: string;
  citations: number[];
}

/** Renders assistant Markdown to sanitised HTML. */
export function renderMarkdown(source: string, options: RenderOptions = {}): RenderedMarkdown {
  const valid = options.validCitations ?? new Set<number>();
  const citations = new Set<number>();

  // Step 1: convert to HTML, with raw HTML escaped by marked (no HTML option).
  let html = marked.parse(source, { async: false }) as string;

  // Step 2: turn [n] citation markers into clickable chips, but only when the
  // number matches a real source. Unknown markers stay as plain text.
  html = html.replace(/\[(\d{1,3})\]/g, (match, raw: string) => {
    const id = Number(raw);
    if (!valid.has(id)) return match;
    citations.add(id);
    return `<span class="citation-ref" data-citation="${id}" role="button" tabindex="0" aria-label="Show source ${id}">${id}</span>`;
  });

  // Step 3: sanitise with a strict allowlist.
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: true,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'img', 'svg', 'math'],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick', 'srcset', 'src'],
    KEEP_CONTENT: true,
  });

  return { html: clean, citations: [...citations] };
}

/**
 * Builds the final answer DOM: sanitised markdown plus enhanced code blocks
 * with highlighting and a copy button.
 */
export function mountMarkdown(
  container: HTMLElement,
  source: string,
  options: RenderOptions = {},
): { citations: number[] } {
  const { html, citations } = renderMarkdown(source, options);
  container.innerHTML = html;

  // Replace every <pre><code> with a structured, copyable code block.
  const codeNodes = [...container.querySelectorAll('pre > code')];
  for (const codeNode of codeNodes) {
    const pre = codeNode.parentElement;
    if (!pre) continue;
    const raw = codeNode.textContent ?? '';
    const classList = codeNode.getAttribute('class') ?? '';
    const language = /language-([\w+#.-]+)/.exec(classList)?.[1] ?? '';
    const block = buildCodeBlock(raw, language);
    pre.replaceWith(block);
  }

  // Wire citation chips to the sources panel.
  if (options.onCitationClick) {
    const handler = options.onCitationClick;
    container.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-citation]');
      if (!target) return;
      const id = Number(target.dataset.citation);
      if (Number.isFinite(id)) {
        event.preventDefault();
        handler(id);
      }
    });
    container.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-citation]');
      if (!target) return;
      event.preventDefault();
      const id = Number(target.dataset.citation);
      if (Number.isFinite(id)) handler(id);
    });
  }

  return { citations };
}

function buildCodeBlock(raw: string, language: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'code-block';

  const header = document.createElement('div');
  header.className = 'code-block__header';

  const lang = document.createElement('span');
  lang.className = 'code-block__lang';
  lang.textContent = language || 'text';
  header.append(lang);

  const actions = document.createElement('div');
  actions.className = 'code-block__actions';

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'code-block__copy';
  copyButton.setAttribute('aria-label', 'Copy code');
  copyButton.innerHTML =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg><span>Copy</span>';
  copyButton.addEventListener('click', async () => {
    const { copyText } = await import('./dom.js');
    const ok = await copyText(raw);
    copyButton.dataset.copied = ok ? 'true' : 'false';
    const label = copyButton.querySelector('span');
    if (label) label.textContent = ok ? 'Copied' : 'Failed';
    window.setTimeout(() => {
      copyButton.dataset.copied = 'false';
      if (label) label.textContent = 'Copy';
    }, 1600);
  });
  actions.append(copyButton);
  header.append(actions);

  const pre = document.createElement('pre');
  const code = document.createElement('code');
  const highlighted = highlightCode(raw, language);
  if (highlighted !== null) {
    code.innerHTML = highlighted;
  } else {
    code.textContent = raw;
  }
  pre.append(code);

  wrapper.append(header, pre);
  return wrapper;
}

/** Strips markdown to plain text (used for titles and copy-to-clipboard). */
export function toPlainText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
