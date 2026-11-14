/**
 * Tiny DOM helpers. The client is vanilla TypeScript: no virtual DOM, no
 * framework runtime. Every node is created from text content (never from an
 * HTML string) except for markdown, which is sanitised before insertion.
 */

type Attrs = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

export function svgIcon(pathMarkup: string, viewBox = '0 0 24 24', size = 24): SVGSVGElement {
  const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wrapper.setAttribute('viewBox', viewBox);
  wrapper.setAttribute('width', String(size));
  wrapper.setAttribute('height', String(size));
  wrapper.setAttribute('fill', 'none');
  wrapper.setAttribute('stroke', 'currentColor');
  wrapper.setAttribute('stroke-width', '1.75');
  wrapper.setAttribute('stroke-linecap', 'round');
  wrapper.setAttribute('stroke-linejoin', 'round');
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.innerHTML = pathMarkup;
  return wrapper;
}

function applyAttrs(node: HTMLElement | SVGElement, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') {
      node.setAttribute('class', String(value));
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      // Only used with pre-sanitised markup.
      node.innerHTML = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as unknown as EventListener);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
}

function appendChildren(node: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function $(selector: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector(selector);
}

export function $$<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/** Formats a byte count for display. */
export function formatBytes(bytes: number | undefined | null): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[exponent]}`;
}

export function formatNumber(value: number | undefined | null): string {
  if (value === null || value === undefined) return '0';
  return value.toLocaleString();
}

export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 0) return '0s';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Copies text with a graceful fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): (...args: Parameters<T>) => void {
  let timer: number | undefined;
  return (...args: Parameters<T>) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  };
}

export function isMobileViewport(): boolean {
  return window.matchMedia('(max-width: 899px)').matches;
}

/** Focuses without scrolling, used after programmatic re-renders. */
export function focusQuietly(node: HTMLElement | null): void {
  if (!node) return;
  try {
    node.focus({ preventScroll: true });
  } catch {
    node.focus();
  }
}
