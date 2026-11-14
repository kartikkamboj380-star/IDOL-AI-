/**
 * Client entry point. Styles are bundled first so the shell paints correctly
 * even if the app initialisation throws.
 */
import './styles/tokens.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/overlays.css';
import './styles/highlight.css';

import { IdolApp } from './app.js';

function showFatalError(message: string): void {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'noscript';
  const heading = document.createElement('h1');
  heading.textContent = 'IDOL AI could not start';
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  const hint = document.createElement('p');
  hint.style.marginTop = '1rem';
  hint.style.color = 'var(--text-tertiary)';
  hint.textContent = 'If this persists, reload the page. The server API may be restarting.';
  wrapper.append(heading, paragraph, hint);
  root.append(wrapper);
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) {
    throw new Error('Missing #app root element.');
  }
  const app = new IdolApp(root);
  await app.start();

  // Expose a tiny debug handle without leaking internals in production markup.
  if (import.meta.env.DEV) {
    (window as unknown as { __idol?: unknown }).__idol = app;
  }
}

void boot().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('IDOL AI failed to start', error);
  showFatalError(error instanceof Error ? error.message : 'Unexpected initialisation error.');
});

// Register the service worker only in production builds: it caches the shell so
// the interface loads instantly and degrades gracefully when the network drops.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support is optional */
    });
  });
}
