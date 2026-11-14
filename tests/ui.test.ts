/**
 * UI integration test (jsdom).
 *
 * This boots the real frontend modules — markdown renderer, message component,
 * state store, API client, app controller — inside a DOM and talks to a real
 * server over HTTP. It is not a screenshot test: it asserts that clicking and
 * typing produce the right DOM and that the rendered answer is sanitised.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { startTestServer, type TestServer } from './helpers.js';
import type { AnswerPayload } from '../shared/types.js';

interface DomContext {
  window: JSDOM['window'];
}

let server: TestServer;
let dom: DomContext;
const realFetch = globalThis.fetch.bind(globalThis);

/** Defines a global that may be read-only on the Node runtime (e.g. navigator). */
function defineGlobal(key: string, value: unknown): void {
  const target = globalThis as unknown as Record<string, unknown>;
  if (target[key] === value) return;
  try {
    Object.defineProperty(target, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  } catch {
    // Non-configurable globals keep the Node implementation; the app tolerates it.
  }
}

/** Installs the minimum browser surface the app modules expect. */
function installGlobals(window: JSDOM['window']): void {
  const global = globalThis as unknown as Record<string, unknown>;
  global.window = window;
  global.document = window.document;
  global.HTMLElement = window.HTMLElement;
  global.HTMLInputElement = window.HTMLInputElement;
  global.HTMLTextAreaElement = window.HTMLTextAreaElement;
  global.HTMLButtonElement = window.HTMLButtonElement;
  global.Element = window.Element;
  global.Node = window.Node;
  global.Event = window.Event;
  global.KeyboardEvent = window.KeyboardEvent;
  global.MouseEvent = window.MouseEvent;
  global.CustomEvent = window.CustomEvent;
  global.DOMParser = window.DOMParser;
  defineGlobal('navigator', window.navigator);
  global.getComputedStyle = window.getComputedStyle.bind(window);
  const raf = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const caf = (handle: number) => clearTimeout(handle);
  global.requestAnimationFrame = raf;
  global.cancelAnimationFrame = caf;
  (window as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = raf;
  (window as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = caf;
  defineGlobal('localStorage', window.localStorage);

  // jsdom does not implement matchMedia at all, and the app uses it for
  // responsive layout and reduced-motion checks.
  const matchMedia = ((query: string) => ({
    matches: /min-width/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  (window as unknown as { matchMedia: unknown }).matchMedia = matchMedia;
  global.matchMedia = matchMedia;

  // The app calls fetch with relative URLs; point them at the test server.
  // `realFetch` must be captured first, or the override would call itself.
  global.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return realFetch(url.startsWith('http') ? url : `${server.baseUrl}${url}`, init);
  }) as typeof fetch;
}

before(async () => {
  try {
    server = await startTestServer();
    dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="app"></div></body></html>', {
      url: 'http://localhost/',
    });
    installGlobals(dom.window);
  } catch (error) {
    console.error('[ui.test setup]', error);
    throw error;
  }
});

after(async () => {
  await server.close();
});

function message(role: 'user' | 'assistant', content: string) {
  return { id: `m_${Math.random().toString(36).slice(2)}`, role, content, createdAt: new Date().toISOString() };
}

function callbacks() {
  return {
    onCopy: () => undefined,
    onRegenerate: () => undefined,
    onEditUser: () => undefined,
    onOpenSource: () => undefined,
    onShowSourcePanel: () => undefined,
    onFeedback: () => undefined,
    feedbackFor: () => null,
  };
}

describe('markdown rendering', () => {
  it('renders GFM tables, code blocks, and headings', async () => {
    const { renderMarkdown, mountMarkdown } = await import('../web/src/lib/markdown.js');
    const { html } = renderMarkdown(
      '# Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n',
    );
    assert.match(html, /<h1/);
    assert.match(html, /<table/);
    assert.match(html, /<pre><code/);

    // mountMarkdown upgrades <pre><code> into a copyable, labelled code block.
    const host = dom.window.document.createElement('div');
    mountMarkdown(host, '```ts\nconst x = 1;\n```');
    const block = host.querySelector('.code-block');
    assert.ok(block, 'code blocks must become copyable components');
    assert.match(block.textContent ?? '', /const x = 1/);
    assert.ok(block.querySelector('button'), 'every code block needs a copy button');
  });

  it('strips scripts, event handlers, and javascript: URLs', async () => {
    const { renderMarkdown } = await import('../web/src/lib/markdown.js');
    const { html } = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[click](javascript:alert(3))\n\n<iframe src="https://evil.test"></iframe>',
    );
    assert.equal(/<script/i.test(html), false);
    assert.equal(/onerror=/i.test(html), false);
    assert.equal(/javascript:/i.test(html), false);
    assert.equal(/<iframe/i.test(html), false);
    assert.equal(/<img/i.test(html), false);
  });

  it('turns only real citations into citation spans', async () => {
    const { renderMarkdown } = await import('../web/src/lib/markdown.js');
    const { html, citations } = renderMarkdown('Fact one [1] and a fake [7].', {
      validCitations: new Set([1, 2]),
    });
    assert.deepEqual(citations, [1]);
    assert.match(html, /citation-ref[^>]*data-citation="1"/);
    assert.equal(html.includes('data-citation="7"'), false);
  });

  it('produces a plain-text version without markup for copying', async () => {
    const { toPlainText } = await import('../web/src/lib/markdown.js');
    const text = toPlainText('# Title\n\nSome **bold** text and a [link](https://example.com).');
    assert.match(text, /Title/);
    assert.equal(text.includes('**'), false);
    assert.equal(text.includes('(https://example.com)'), false);
  });
});

describe('state store and persistence', () => {
  it('creates, renames, deletes, and searches conversations', async () => {
    const { Store, deriveTitle } = await import('../web/src/lib/state.js');
    const store = new Store();
    const first = store.createConversation();
    assert.ok(first.id.length > 0);
    // Titles are sentence fragments: trailing punctuation is trimmed.
    assert.equal(deriveTitle('  What are the benchmark results?  '), 'What are the benchmark results');
    assert.equal(deriveTitle('   '), 'New chat');

    store.addMessage(first.id, message('user', 'How do I install this?'));
    store.addMessage(first.id, message('assistant', 'Run pip install -e . to install it.'));
    store.renameConversation(first.id, 'Installation notes');

    const renamed = store.state.conversations.find((item) => item.id === first.id);
    assert.equal(renamed?.title, 'Installation notes');

    const history = store.historyFor(first.id);
    assert.equal(history.length, 2);
    assert.equal(history[1]?.role, 'assistant');

    const second = store.createConversation();
    store.deleteConversation(first.id);
    assert.equal(store.state.conversations.some((item) => item.id === first.id), false);
    assert.ok(store.state.conversations.some((item) => item.id === second.id));
  });

  it('persists conversations across store instances', async () => {
    const { Store } = await import('../web/src/lib/state.js');
    const store = new Store();
    const conversation = store.createConversation();
    store.addMessage(conversation.id, message('user', 'persisted question'));
    const reloaded = new Store();
    const restored = reloaded.state.conversations.find((item) => item.id === conversation.id);
    assert.ok(restored);
    assert.equal(restored?.messages[0]?.content, 'persisted question');
    assert.ok(restored?.title.length, 'a conversation always has a title');
  });

  it('recovers from a corrupted storage entry instead of crashing', async () => {
    dom.window.localStorage.setItem('idol.conversations.v1', '{not valid json');
    const { Store } = await import('../web/src/lib/state.js');
    const store = new Store();
    assert.ok(Array.isArray(store.state.conversations));
  });
});

describe('message component', () => {
  it('renders user text as text, never as HTML', async () => {
    const { renderUserMessage } = await import('../web/src/components/message.js');
    const node = renderUserMessage(
      { id: 'm1', role: 'user', content: '<img src=x onerror="alert(1)"> hello', createdAt: new Date().toISOString() },
      callbacks(),
    );
    assert.equal(node.querySelector('img'), null);
    assert.match(node.textContent ?? '', /<img src=x/);
  });

  it('renders an assistant answer with pills, sources, and findings', async () => {
    const { renderAssistantMessage } = await import('../web/src/components/message.js');
    const answer: Partial<AnswerPayload> = {
      id: 'a1',
      text: 'PSNR is 12.25 [1].',
      mode: 'knowledge',
      intent: 'factual_lookup',
      confidence: 'medium',
      sources: [
        {
          id: 1,
          sourceId: 's',
          sourceName: 'repo',
          path: 'README.md',
          heading: 'Benchmark',
          startLine: 127,
          endLine: 139,
          excerpt: 'Idol 12.25 PSNR',
          kind: 'markdown',
          language: 'markdown',
          score: 9,
          htmlUrl: null,
        },
      ],
      validation: {
        citations: [{ marker: 1, status: 'verified', sourceId: 's', path: 'README.md' }],
        passed: true,
        removedMarkers: 0,
        unsupportedClaims: [],
        citationCoverage: 1,
        notes: [],
      },
      timings: { total: 42 },
      codeFindings: [],
    };
    const node = renderAssistantMessage(
      {
        id: 'm2',
        role: 'assistant',
        content: answer.text as string,
        createdAt: new Date().toISOString(),
        answer: answer as AnswerPayload,
      },
      callbacks(),
      { isLast: true, canRegenerate: true },
    );
    assert.ok(node.querySelector('.pill'));
    assert.match(node.textContent ?? '', /README\.md/);
    assert.match(node.textContent ?? '', /12\.25/);
    const citation = node.querySelector('.citation-ref');
    assert.ok(citation, 'citation markers must be interactive');
  });

  it('shows a warning when an inference answer failed validation', async () => {
    const { renderAssistantMessage } = await import('../web/src/components/message.js');
    const node = renderAssistantMessage(
      {
        id: 'm3',
        role: 'assistant',
        content: 'Unsupported claim.',
        createdAt: new Date().toISOString(),
        answer: {
          id: 'a3',
          text: 'Unsupported claim.',
          mode: 'inference',
          intent: 'factual_lookup',
          confidence: 'low',
          sources: [],
          validation: {
            citations: [],
            passed: false,
            unsupportedClaims: ['made up'],
            removedMarkers: 0,
            citationCoverage: 0,
            notes: [],
          },
          timings: { total: 10 },
          codeFindings: [],
        } as unknown as AnswerPayload,
      },
      callbacks(),
      { isLast: true, canRegenerate: true },
    );
    assert.ok(node.querySelector('.notice--warning'));
  });
});

describe('api client', () => {
  it('reads status and sources from the server', async () => {
    const { api } = await import('../web/src/lib/api.js');
    const status = await api.status();
    assert.equal(status.inference.mode, 'knowledge');
    const sources = await api.sources();
    assert.ok(sources.sources.length > 0);
  });

  it('raises a typed ApiError with the server message', async () => {
    const { api, ApiError } = await import('../web/src/lib/api.js');
    await assert.rejects(
      () => api.file('src_missing', 'README.md'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 404);
        assert.ok(error.message.length > 0);
        return true;
      },
    );
  });

  it('streams a chat answer and forwards every event', async () => {
    const { streamChat } = await import('../web/src/lib/api.js');
    const events: string[] = [];
    let deltaText = '';
    await streamChat(
      { message: 'What is this repository about?', history: [], conversationId: 'ui-test' },
      {
        onEvent: (event) => {
          events.push(event.type);
          if (event.type === 'delta') deltaText += event.text;
        },
        onError: (error) => {
          throw error;
        },
        onClose: () => undefined,
      },
    );
    assert.ok(events.includes('stage'));
    assert.ok(events.includes('done'));
    assert.ok(deltaText.length > 0);
  });
});

describe('app controller', () => {
  it('boots, renders the shell, and completes a full send/receive journey', async () => {
    const { IdolApp } = await import('../web/src/app.js');
    const root = dom.window.document.getElementById('app') as HTMLElement;
    const app = new IdolApp(root);
    await app.start();

    // Shell: composer, sidebar, and empty state all exist.
    const textarea = root.querySelector('textarea');
    assert.ok(textarea, 'the composer must render');
    assert.ok(root.querySelector('.sidebar'), 'the sidebar must render');
    assert.ok(root.textContent?.includes('IDOL'), 'branding must be present');

    // No interactive element may contain another: nested buttons/links are
    // invalid HTML and break keyboard focus order.
    const interactive = [...root.querySelectorAll('button, a[href], input, textarea, select')];
    for (const node of interactive) {
      const nested = node.querySelector('button, a[href], input, textarea, select');
      assert.equal(nested, null, `nested interactive element inside <${node.tagName.toLowerCase()}>`);
    }

    // Type a question and submit it through the real DOM event.
    textarea.value = 'What is this repository about?';
    textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    const form = textarea.closest('form');
    assert.ok(form);
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));

    // Wait for the streamed answer to land in the DOM.
    const deadline = Date.now() + 15_000;
    let bodyText = '';
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      bodyText = root.textContent ?? '';
      if (/No language model was used|Gaussian|Source:/i.test(bodyText)) break;
    }
    assert.match(bodyText, /What is this repository about\?/, 'the user turn must render');
    assert.match(bodyText, /No language model was used|Gaussian/i, 'the answer must render');

    // The conversation is persisted, so the sidebar lists it.
    const { Store } = await import('../web/src/lib/state.js');
    const store = new Store();
    assert.ok(store.state.conversations.length > 0, 'the conversation must persist');

    // Teardown must release the status poller, or the process never exits.
    // It deliberately leaves the DOM alone: the host may still be on screen.
    app.destroy();
    app.destroy(); // idempotent
    assert.ok(root.querySelector('.sidebar'), 'teardown does not destroy rendered markup');
  });
});
