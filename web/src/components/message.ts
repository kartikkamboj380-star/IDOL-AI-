/**
 * Message rendering: user bubbles and assistant answers with citations,
 * sources, validation state, code findings, and per-message actions.
 */
import type { AnswerPayload, ChatMessage, SourceRef } from '../types.js';
import { copyText, formatDuration, el } from '../lib/dom.js';
import { icons } from '../lib/icons.js';
import { mountMarkdown, toPlainText } from '../lib/markdown.js';

export interface MessageCallbacks {
  onCopy: (text: string) => void;
  onRegenerate: (assistantMessageId: string) => void;
  onEditUser: (messageId: string) => void;
  onOpenSource: (source: SourceRef) => void;
  onShowSourcePanel: (assistantMessageId: string, sourceId: number) => void;
  onFeedback: (assistantMessageId: string, value: 'up' | 'down') => void;
  /** Feedback currently recorded for this message, if any. */
  feedbackFor: (messageId: string) => 'up' | 'down' | null;
}

const INTENT_LABELS: Record<string, string> = {
  greeting: 'greeting',
  capabilities: 'capabilities',
  repo_overview: 'overview',
  documentation_search: 'docs search',
  how_to: 'how-to',
  factual_lookup: 'lookup',
  code_explanation: 'code',
  bug_analysis: 'bug analysis',
  summarization: 'summary',
  comparison: 'comparison',
  troubleshooting: 'troubleshooting',
  out_of_scope: 'out of scope',
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: 'high confidence',
  medium: 'medium confidence',
  low: 'low confidence',
  none: 'no evidence',
};

export function renderUserMessage(message: ChatMessage, callbacks: MessageCallbacks): HTMLElement {
  const wrapper = el('div', { class: 'message message--user', 'data-message-id': message.id });
  wrapper.append(el('div', { class: 'message__user-bubble', text: message.content }));

  const actions = el('div', { class: 'message__actions' });
  actions.append(
    actionButton('copy', 'Copy', () => {
      void copyText(message.content);
      callbacks.onCopy('Message copied');
    }),
    actionButton('edit', 'Edit', () => callbacks.onEditUser(message.id)),
  );
  wrapper.append(actions);
  return wrapper;
}

export function renderAssistantMessage(
  message: ChatMessage,
  callbacks: MessageCallbacks,
  options: { isLast: boolean; canRegenerate: boolean },
): HTMLElement {
  const wrapper = el('div', { class: 'message message--assistant', 'data-message-id': message.id });

  const header = el('div', { class: 'assistant-header' });
  header.append(el('div', { class: 'assistant-avatar', text: 'ID' }));
  header.append(el('span', { class: 'assistant-name', text: 'IDOL AI' }));

  const meta = el('div', { class: 'assistant-meta' });
  const answer = message.answer;
  if (answer) {
    if (answer.mode) {
      meta.append(
        el('span', {
          class: `pill pill--mode-${answer.mode}`,
          title:
            answer.mode === 'inference'
              ? 'A configured language model generated this answer from retrieved passages.'
              : 'Composed by the extractive knowledge engine. No language model was used.',
          text: answer.mode === 'inference' ? 'inference' : 'knowledge',
        }),
      );
    }
    if (answer.intent) {
      meta.append(el('span', { class: 'pill', text: INTENT_LABELS[answer.intent] ?? answer.intent }));
    }
    if (answer.confidence) {
      meta.append(
        el('span', {
          class: `pill pill--confidence-${answer.confidence}`,
          title: `Intent matched with ${Math.round(answer.intentConfidence * 100)}% rule confidence.`,
          text: CONFIDENCE_LABEL[answer.confidence] ?? answer.confidence,
        }),
      );
    }
    const total = answer.timings?.total;
    if (total) meta.append(el('span', { class: 'pill', text: formatDuration(total) }));
  }
  header.append(meta);
  wrapper.append(header);

  const body = el('div', { class: 'message__body md' });
  wrapper.append(body);

  if (message.error) {
    body.replaceWith(renderError(message, callbacks));
  } else if (answer) {
    const validCitations = new Set(answer.sources.map((source) => source.id));
    mountMarkdown(body, answer.text, {
      validCitations,
      onCitationClick: (id) => callbacks.onShowSourcePanel(message.id, id),
    });
  } else {
    // Streaming state: plain text so partial markdown never breaks layout.
    body.textContent = message.content;
  }

  if (answer) {
    if (answer.sources.length > 0) {
      wrapper.append(renderSourcesPanel(message.id, answer.sources, callbacks));
    }
    if (answer.codeFindings.length > 0) {
      wrapper.append(renderFindings(answer));
    }
    if (answer.validation && !answer.validation.passed && answer.mode === 'inference') {
      wrapper.append(
        el(
          'div',
          { class: 'notice notice--warning', style: 'margin-top:8px' },
          iconSpan(icons.alert),
          el(
            'div',
            { class: 'notice__body' },
            el('div', { class: 'notice__title', text: 'Some citations could not be verified' }),
            el('div', {
              text: `${answer.validation.unsupportedClaims.length || answer.validation.removedMarkers} passage reference(s) did not match the retrieved context and were removed. Verify important details against the listed sources.`,
            }),
          ),
        ),
      );
    }
  }

  const actions = el('div', { class: 'message__actions' });
  if (answer) {
    actions.append(
      actionButton('copy', 'Copy', () => {
        void copyText(toPlainText(answer.text));
        callbacks.onCopy('Answer copied');
      }),
    );
    if (options.canRegenerate) {
      actions.append(actionButton('refresh', 'Regenerate', () => callbacks.onRegenerate(message.id)));
    }

    const feedback = callbacks.feedbackFor(message.id);
    const upButton = actionButton('thumbUp', 'Helpful', () => callbacks.onFeedback(message.id, 'up'));
    const downButton = actionButton('thumbDown', 'Not helpful', () => callbacks.onFeedback(message.id, 'down'));
    if (feedback === 'up') upButton.dataset.active = 'true';
    if (feedback === 'down') downButton.dataset.active = 'true';
    actions.append(upButton, downButton);

    if (answer.validation) {
      actions.append(
        el('span', {
          class: 'pill',
          style: 'margin-left:4px',
          title: 'Citation markers are checked against the retrieved passages before display.',
          text: `${answer.validation.citations.length} citation${answer.validation.citations.length === 1 ? '' : 's'} verified`,
        }),
      );
    }
  }
  if (actions.childElementCount > 0) wrapper.append(actions);
  return wrapper;
}

function renderError(message: ChatMessage, callbacks: MessageCallbacks): HTMLElement {
  const error = message.error;
  const notice = el('div', { class: 'notice notice--error' }, iconSpan(icons.alert));
  const body = el('div', { class: 'notice__body' });
  body.append(el('div', { class: 'notice__title', text: 'That message could not be answered' }));
  body.append(el('div', { text: error?.message ?? 'Unknown error.' }));
  const actions = el('div', { class: 'notice__actions' });
  if (error?.retryable) {
    const retry = el('button', { type: 'button', class: 'notice__button' });
    retry.append(iconSpan(icons.refresh), el('span', { text: 'Try again' }));
    retry.addEventListener('click', () => callbacks.onRegenerate(message.id));
    actions.append(retry);
  }
  body.append(actions);
  notice.append(body);
  return notice;
}

function renderSourcesPanel(messageId: string, sources: SourceRef[], callbacks: MessageCallbacks): HTMLElement {
  const panel = el('div', { class: 'sources-panel', 'data-open': 'false' });
  const toggle = el('button', {
    type: 'button',
    class: 'sources-panel__toggle',
    'aria-expanded': 'false',
  });
  const chevron = iconSpan(icons.chevronRight);
  chevron.classList.add('chevron');
  toggle.append(chevron, el('span', { text: 'Sources' }), el('span', { class: 'sources-panel__count', text: String(sources.length) }));

  const list = el('ul', { class: 'sources-list' });
  list.hidden = true;
  for (const source of sources) {
    list.append(renderSourceItem(source, callbacks));
  }

  toggle.addEventListener('click', () => {
    const open = panel.dataset.open === 'true';
    panel.dataset.open = open ? 'false' : 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    list.hidden = open;
  });

  panel.append(toggle, list);
  panel.dataset.messageId = messageId;
  return panel;
}

function renderSourceItem(source: SourceRef, callbacks: MessageCallbacks): HTMLElement {
  const item = el('li', { class: 'source-item', 'data-source-id': String(source.id) });
  item.append(el('span', { class: 'source-item__num', text: String(source.id) }));

  const main = el('div', { class: 'source-item__main' });
  main.append(el('span', { class: 'source-item__path', text: source.path }));
  const where = source.heading
    ? `${source.heading} · lines ${source.startLine}–${source.endLine}`
    : `lines ${source.startLine}–${source.endLine}`;
  main.append(el('div', { class: 'source-item__heading', text: where }));
  if (source.excerpt) main.append(el('div', { class: 'source-item__excerpt', text: source.excerpt }));
  item.append(main);

  const actions = el('div', { class: 'source-item__actions' });
  const view = el('button', {
    type: 'button',
    class: 'source-item__button',
    'aria-label': `Open ${source.path}`,
    title: 'Open file',
  });
  view.append(iconSpan(icons.file));
  view.addEventListener('click', () => callbacks.onOpenSource(source));
  actions.append(view);

  if (source.htmlUrl) {
    const link = el('a', {
      class: 'source-item__button',
      href: source.htmlUrl,
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': 'Open on GitHub',
      title: 'Open on GitHub',
    });
    link.append(iconSpan(icons.external));
    actions.append(link);
  }

  const copy = el('button', {
    type: 'button',
    class: 'source-item__button',
    'aria-label': 'Copy citation',
    title: 'Copy citation',
  });
  copy.append(iconSpan(icons.copy));
  copy.addEventListener('click', () => {
    void copyText(`${source.path}${source.heading ? ` › ${source.heading}` : ''} (lines ${source.startLine}-${source.endLine})`);
    callbacks.onCopy('Citation copied');
  });
  actions.append(copy);

  item.append(actions);
  return item;
}

function renderFindings(answer: AnswerPayload): HTMLElement {
  const wrapper = el('div', { class: 'findings' });
  const header = el('button', { type: 'button', class: 'findings__header', 'aria-expanded': 'false' });
  header.append(iconSpan(icons.code), el('span', { text: `Static code observations (${answer.codeFindings.length})` }));
  const list = el('ul', { class: 'findings__list' });
  list.hidden = true;
  for (const finding of answer.codeFindings) {
    const item = el('li', { class: 'finding' });
    item.append(el('span', { class: 'finding__severity', 'data-severity': finding.severity }));
    const body = el('div');
    body.append(el('div', { class: 'finding__message', text: finding.message }));
    body.append(
      el('div', {
        class: 'finding__where',
        text: `${finding.path}:${finding.startLine}${finding.endLine !== finding.startLine ? `-${finding.endLine}` : ''}`,
      }),
    );
    item.append(body);
    list.append(item);
  }
  header.addEventListener('click', () => {
    const open = !list.hidden;
    list.hidden = open;
    header.setAttribute('aria-expanded', open ? 'false' : 'true');
  });
  wrapper.append(header, list);
  return wrapper;
}

function actionButton(icon: keyof typeof icons, label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', class: 'action-button', 'aria-label': label, title: label });
  button.append(iconSpan(icons[icon]), el('span', { text: label }));
  button.addEventListener('click', onClick);
  return button;
}

function iconSpan(path: string): HTMLSpanElement {
  const span = el('span', { style: 'display:inline-flex' });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  return span;
}
