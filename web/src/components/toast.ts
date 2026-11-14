/** Transient notifications with optional action, capped and auto-dismissed. */
import { el } from '../lib/dom.js';
import { icons } from '../lib/icons.js';

export interface ToastOptions {
  variant?: 'default' | 'success' | 'error';
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}

let stack: HTMLElement | null = null;

function ensureStack(): HTMLElement {
  if (stack && document.body.contains(stack)) return stack;
  stack = el('div', { class: 'toast-stack', role: 'region', 'aria-live': 'polite', 'aria-label': 'Notifications' });
  document.body.append(stack);
  return stack;
}

export function showToast(message: string, options: ToastOptions = {}): void {
  const container = ensureStack();
  while (container.childElementCount >= 3) container.firstElementChild?.remove();

  const toast = el('div', { class: 'toast', 'data-variant': options.variant ?? 'default', role: 'status' });
  const iconPath = options.variant === 'error' ? icons.alert : options.variant === 'success' ? icons.check : icons.info;
  const icon = el('span', { style: 'display:inline-flex' });
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPath}</svg>`;
  toast.append(icon, el('span', { text: message }));

  if (options.action) {
    const action = el('button', { type: 'button', class: 'toast__action', text: options.action.label });
    action.addEventListener('click', () => {
      options.action?.onClick();
      dismiss();
    });
    toast.append(action);
  }

  container.append(toast);

  const duration = options.durationMs ?? (options.action ? 6000 : 3200);
  let timer = window.setTimeout(dismiss, duration);

  function dismiss(): void {
    window.clearTimeout(timer);
    toast.classList.add('leaving');
    window.setTimeout(() => toast.remove(), 180);
  }

  toast.addEventListener('mouseenter', () => window.clearTimeout(timer));
  toast.addEventListener('mouseleave', () => {
    timer = window.setTimeout(dismiss, 1200);
  });
}
