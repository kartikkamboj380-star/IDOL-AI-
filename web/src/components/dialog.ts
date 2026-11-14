/**
 * Accessible dialog primitive: focus trap, Escape to close, backdrop click,
 * and focus restoration. Built once and reused by every overlay in the app.
 */
import { el, focusQuietly } from '../lib/dom.js';
import { icons } from '../lib/icons.js';

export interface DialogOptions {
  title: string;
  subtitle?: string;
  wide?: boolean;
  /** Extra class for the dialog body. */
  bodyClass?: string;
  onClose?: () => void;
}

export interface DialogInstance {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  close: () => void;
  setSubtitle: (text: string) => void;
  setTitle: (text: string) => void;
}

const openDialogs: DialogInstance[] = [];

export function openDialog(options: DialogOptions): DialogInstance {
  const previouslyFocused = document.activeElement as HTMLElement | null;
  const backdrop = el('div', { class: 'dialog-backdrop', role: 'presentation' });
  const dialog = el('div', {
    class: `dialog${options.wide ? ' dialog--wide' : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'dialog-title',
  });

  const header = el('div', { class: 'dialog__header' });
  const titleGroup = el('div', { class: 'dialog__title-group' });
  const title = el('h2', { class: 'dialog__title', id: 'dialog-title', text: options.title });
  const subtitle = el('p', { class: 'dialog__subtitle', text: options.subtitle ?? '' });
  if (!options.subtitle) subtitle.hidden = true;
  titleGroup.append(title, subtitle);

  const closeButton = el('button', {
    type: 'button',
    class: 'icon-button',
    'aria-label': 'Close dialog',
    title: 'Close (Esc)',
  });
  closeButton.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.close}</svg>`;
  header.append(titleGroup, closeButton);

  const body = el('div', { class: `dialog__body${options.bodyClass ? ` ${options.bodyClass}` : ''}` });
  const footer = el('div', { class: 'dialog__footer' });
  footer.hidden = true;

  dialog.append(header, body, footer);
  backdrop.append(dialog);
  document.body.append(backdrop);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    window.removeEventListener('keydown', onKeyDown, true);
    backdrop.remove();
    const index = openDialogs.indexOf(instance);
    if (index >= 0) openDialogs.splice(index, 1);
    options.onClose?.();
    focusQuietly(previouslyFocused);
  };

  const instance: DialogInstance = {
    root: dialog,
    body,
    footer,
    close,
    setSubtitle: (text: string) => {
      subtitle.textContent = text;
      subtitle.hidden = !text;
    },
    setTitle: (text: string) => {
      title.textContent = text;
    },
  };

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    // Only the topmost dialog reacts to keyboard events.
    if (openDialogs[openDialogs.length - 1] !== instance) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.offsetParent !== null || node === document.activeElement);
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  window.addEventListener('keydown', onKeyDown, true);
  openDialogs.push(instance);

  // Focus the first meaningful control, not the close button.
  window.requestAnimationFrame(() => {
    const target =
      dialog.querySelector<HTMLElement>('input, textarea, select') ??
      dialog.querySelector<HTMLElement>('.dialog__body button, .dialog__footer button') ??
      closeButton;
    focusQuietly(target);
  });

  return instance;
}

export function closeAllDialogs(): void {
  for (const dialog of [...openDialogs].reverse()) dialog.close();
}

export function hasOpenDialog(): boolean {
  return openDialogs.length > 0;
}
