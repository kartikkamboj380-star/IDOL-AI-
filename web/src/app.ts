/**
 * IDOL AI client controller.
 *
 * Responsibilities: own the layout shell, render the sidebar/thread/composer
 * from `Store` state, drive the SSE chat lifecycle (send, stream, stop,
 * regenerate, retry), and coordinate dialogs. Rendering is intentionally
 * targeted (patch known regions) rather than a full re-render, so typing in the
 * composer and scroll position are never disturbed.
 */
import { api, ApiError, streamChat } from './lib/api.js';
import { clear, copyText, debounce, el, formatNumber, formatBytes, relativeTime, $, $$ } from './lib/dom.js';
import { icons } from './lib/icons.js';
import { preloadCommonLanguages } from './lib/highlight.js';
import { escapeHtml } from './lib/escape.js';
import { toPlainText } from './lib/markdown.js';
import { Store, deriveTitle } from './lib/state.js';
import { exportConversations } from './lib/storage.js';
import { renderAssistantMessage, renderUserMessage, type MessageCallbacks } from './components/message.js';
import { ProcessingIndicator } from './components/processing.js';
import { renderEmptyState } from './components/empty-state.js';
import { closeAllDialogs, hasOpenDialog, openDialog } from './components/dialog.js';
import { openSourcesDialog } from './components/sources-dialog.js';
import { openFileBrowser } from './components/file-browser.js';
import { showToast } from './components/toast.js';
import type { AnswerPayload, ChatMessage, Conversation, SourceRef, Stage, StreamEvent } from './types.js';

const STAGE_LABELS: Record<Stage, string> = {
  understanding: 'Understand',
  gathering: 'Search GitHub',
  evidence: 'Collect evidence',
  writing: 'Write answer',
  verifying: 'Verify citations',
  complete: 'Done',
};

export class IdolApp {
  private readonly root: HTMLElement;
  private readonly store = new Store();

  // Layout nodes
  private sidebarEl!: HTMLElement;
  private scrimEl!: HTMLElement;
  private topbarEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private threadEl!: HTMLElement;
  private composerRegionEl!: HTMLElement;
  private conversationListEl!: HTMLElement;
  private statusBadgeEl!: HTMLElement;
  private titleTextEl!: HTMLElement;
  private sourcesRowEl!: HTMLElement;
  private suggestionsEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendButtonEl!: HTMLButtonElement;
  private stopButtonEl!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  private emptyStateEl: HTMLElement | null = null;
  private currentAssistantEl: HTMLElement | null = null;
  private processingEl: ProcessingIndicator | null = null;
  private streamingEl: HTMLElement | null = null;
  private streamingText = '';

  // Runtime
  private abortController: AbortController | null = null;
  private activeRequestId = 0;
  private lastPrompt: { conversationId: string; messageId: string; text: string } | null = null;
  private editingMessageId: string | null = null;
  private conversationSearchTerm = '';
  private searchDialogEl: HTMLElement | null = null;
  private statusPollTimer: number | null = null;
  private isNearBottom = true;
  private connectionRetryTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;
  private readonly teardown = new Set<() => void>();

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /* ================================================================== */
  /* Boot                                                                */
  /* ================================================================== */

  async start(): Promise<void> {
    this.buildShell();
    this.attachGlobalHandlers();
    this.unsubscribe = this.store.subscribe(() => this.renderSidebar());
    this.renderSidebar();
    this.renderThread();
    this.renderComposerSources();
    preloadCommonLanguages();

    await this.refreshStatus();
    await this.refreshSources();
    await this.refreshSuggestions();

    // Poll status while the server is still indexing so the UI stays truthful.
    this.statusPollTimer = window.setInterval(() => {
      void this.refreshStatus();
      void this.refreshSources();
    }, 20_000);

    this.restoreDraft();
    this.textareaEl.focus();
  }

  /**
   * Releases every timer, listener, and in-flight request this controller owns.
   * Safe to call more than once. Without this the app cannot be embedded,
   * hot-reloaded, or unit-tested without leaking the status poller.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abortController?.abort();
    this.abortController = null;
    if (this.statusPollTimer !== null) {
      window.clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    if (this.connectionRetryTimer !== null) {
      window.clearTimeout(this.connectionRetryTimer);
      this.connectionRetryTimer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const cleanup of this.teardown) cleanup();
    this.teardown.clear();
  }

  /* ================================================================== */
  /* Shell                                                               */
  /* ================================================================== */

  private buildShell(): void {
    clear(this.root);

    /* ---- sidebar ---- */
    this.sidebarEl = el('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Conversations' });

    const sidebarHeader = el('div', { class: 'sidebar__header' });
    const brand = el('a', { class: 'brand', href: '#', 'aria-label': 'IDOL AI home' });
    brand.append(el('span', { class: 'brand__mark', text: 'ID' }));
    const brandText = el('span', { class: 'brand__text' });
    brandText.append(el('span', { class: 'brand__name', text: 'IDOL AI' }), el('span', { class: 'brand__tag', text: 'repository intelligence' }));
    brand.append(brandText);
    brand.addEventListener('click', (event) => {
      event.preventDefault();
      this.startNewChat();
    });
    const closeSidebar = this.iconButton(icons.close, 'Close sidebar', () => this.store.setSidebarOpen(false));
    closeSidebar.classList.add('mobile-only');
    sidebarHeader.append(brand, closeSidebar);
    this.sidebarEl.append(sidebarHeader);

    const actions = el('div', { class: 'sidebar__actions' });
    const newChat = el('button', { type: 'button', class: 'new-chat' });
    newChat.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.plus}</svg><span>New chat</span>`;
    newChat.addEventListener('click', () => this.startNewChat());
    actions.append(newChat);
    this.sidebarEl.append(actions);

    const searchWrap = el('div', { class: 'sidebar__search' });
    searchWrap.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.search}</svg>`;
    const searchInput = el('input', {
      type: 'search',
      placeholder: 'Search conversations',
      'aria-label': 'Search conversations',
      autocomplete: 'off',
    }) as HTMLInputElement;
    searchInput.addEventListener(
      'input',
      debounce(() => {
        this.conversationSearchTerm = searchInput.value.trim().toLowerCase();
        this.renderConversationList();
      }, 120),
    );
    searchWrap.append(searchInput);
    this.sidebarEl.append(searchWrap);

    this.conversationListEl = el('nav', { class: 'conversation-list', 'aria-label': 'Conversation history' });
    this.sidebarEl.append(this.conversationListEl);

    const footer = el('div', { class: 'sidebar__footer' });
    footer.append(
      this.sidebarLink(icons.database, 'Knowledge sources', () => this.openSources(), 'sources'),
      this.sidebarLink(icons.search, 'Search repository', () => this.openSearch(), 'search'),
      this.sidebarLink(icons.code, 'Keyboard shortcuts', () => this.openShortcuts()),
      this.sidebarLink(icons.download, 'Export chats', () => this.exportChats()),
      this.sidebarLink(icons.moon, 'Toggle theme', () => this.toggleTheme()),
    );
    this.sidebarEl.append(footer);

    this.scrimEl = el('div', { class: 'sidebar__scrim', 'data-visible': 'false' });
    this.scrimEl.addEventListener('click', () => this.store.setSidebarOpen(false));

    /* ---- main ---- */
    const main = el('div', { class: 'main' });

    this.topbarEl = el('header', { class: 'topbar' });
    const menuButton = this.iconButton(icons.menu, 'Open sidebar', () => this.store.setSidebarOpen(true));
    menuButton.classList.add('mobile-only');
    this.titleTextEl = el('span', { class: 'topbar__title-text', text: 'New chat' });
    const titleWrap = el('div', { class: 'topbar__title' }, this.titleTextEl);

    this.statusBadgeEl = el('button', { type: 'button', class: 'topbar__badge', 'aria-label': 'Engine status' });
    this.statusBadgeEl.addEventListener('click', () => this.openStatusDialog());

    const newChatButton = this.iconButton(icons.plus, 'New chat', () => this.startNewChat());
    newChatButton.classList.add('desktop-only');

    this.topbarEl.append(menuButton, titleWrap, this.statusBadgeEl, newChatButton);

    this.scrollEl = el('div', { class: 'thread-scroll', id: 'thread-scroll' });
    this.threadEl = el('div', { class: 'thread', id: 'thread', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
    this.scrollEl.append(this.threadEl);
    this.scrollEl.addEventListener('scroll', () => {
      const distance = this.scrollEl.scrollHeight - this.scrollEl.scrollTop - this.scrollEl.clientHeight;
      this.isNearBottom = distance < 120;
      this.topbarEl.dataset.scrolled = String(this.scrollEl.scrollTop > 8);
    });

    this.composerRegionEl = el('div', { class: 'composer-region' });
    this.composerRegionEl.append(this.buildComposer());

    main.append(this.topbarEl, this.scrollEl, this.composerRegionEl);
    this.root.append(this.sidebarEl, this.scrimEl, main);

    const skipLink = el('a', { class: 'skip-link', href: '#composer-input', text: 'Skip to message input' });
    this.root.prepend(skipLink);
  }

  private buildComposer(): HTMLElement {
    const composer = el('div', { class: 'composer' });

    this.sourcesRowEl = el('div', { class: 'composer__sources', 'aria-label': 'Restrict search to sources' });
    composer.append(this.sourcesRowEl);

    // A real <form> gives the composer correct semantics: screen readers
    // announce it, Enter submits it, and the send button is a submit button.
    const frame = el('form', { class: 'composer__frame', 'aria-label': 'Send a message' });
    const row = el('div', { class: 'composer__input-row' });

    this.textareaEl = el('textarea', {
      id: 'composer-input',
      placeholder: 'Ask about your repositories…',
      rows: '1',
      'aria-label': 'Message IDOL AI',
      autocomplete: 'off',
      spellcheck: 'true',
    }) as HTMLTextAreaElement;
    this.textareaEl.addEventListener('input', () => this.autoGrow());
    this.textareaEl.addEventListener('keydown', (event) => this.onComposerKeyDown(event));
    this.textareaEl.addEventListener('paste', () => {
      window.setTimeout(() => this.autoGrow(), 0);
    });

    this.sendButtonEl = el('button', {
      type: 'submit',
      class: 'composer__send',
      'aria-label': 'Send message',
      title: 'Send (Enter)',
      disabled: true,
    }) as HTMLButtonElement;
    this.sendButtonEl.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.send}</svg>`;
    this.sendButtonEl.addEventListener('click', () => void this.sendCurrent());

    this.stopButtonEl = el('button', {
      type: 'button',
      class: 'composer__stop',
      'aria-label': 'Stop generating',
      hidden: true,
      title: 'Stop generating (Esc)',
    }) as HTMLButtonElement;
    this.stopButtonEl.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true">${icons.stop}</svg>`;
    this.stopButtonEl.addEventListener('click', () => this.stopGeneration());

    row.append(this.textareaEl, this.sendButtonEl, this.stopButtonEl);
    frame.append(row);
    frame.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.sendCurrent();
    });
    composer.append(frame);

    this.hintEl = el('div', { class: 'composer__hint' });
    this.hintEl.innerHTML = `<span><kbd>Enter</kbd> to send</span><span class="composer__hint-sep">|</span><span><kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line</span>`;
    composer.append(this.hintEl);

    return composer;
  }

  /* ================================================================== */
  /* Sidebar rendering                                                   */
  /* ================================================================== */

  private renderSidebar(): void {
    const { sidebarOpen, preferences } = this.store.state;
    const mobile = window.matchMedia('(max-width: 899px)').matches;
    this.sidebarEl.dataset.open = String(sidebarOpen || (!mobile && !preferences.sidebarCollapsed));
    this.scrimEl.dataset.visible = String(sidebarOpen && mobile);
    document.body.style.overflow = sidebarOpen && mobile ? 'hidden' : '';

    this.renderConversationList();

    // Sources link shows corpus counts.
    const sourcesLink = this.sidebarEl.querySelector<HTMLElement>('[data-sidebar-action="sources"]');
    const meta = sourcesLink?.querySelector('.sidebar-link__meta');
    if (meta) {
      const stats = this.store.state.status?.knowledge;
      meta.textContent = stats ? `${formatNumber(stats.totalPassages)}` : '';
    }

    const conversation = this.store.activeConversation;
    this.titleTextEl.textContent = conversation && conversation.messages.length > 0 ? conversation.title : 'New chat';
    this.renderStatusBadge();
  }

  private renderConversationList(): void {
    const list = this.conversationListEl;
    clear(list);

    const conversations = this.store.state.conversations;
    const term = this.conversationSearchTerm;
    const filtered = term.length === 0
      ? conversations
      : conversations.filter((conversation) => {
          if (conversation.title.toLowerCase().includes(term)) return true;
          return conversation.messages.some((message) => message.content.toLowerCase().includes(term));
        });

    if (filtered.length === 0) {
      list.append(
        el('div', {
          class: 'conversation-empty',
          text: term.length > 0 ? `No conversations match “${term}”.` : 'No conversations yet. Start one below.',
        }),
      );
      return;
    }

    const now = Date.now();
    const groups = new Map<string, Conversation[]>();
    for (const conversation of filtered) {
      const label = groupLabel(new Date(conversation.updatedAt).getTime(), now);
      const bucket = groups.get(label) ?? [];
      bucket.push(conversation);
      groups.set(label, bucket);
    }

    for (const [label, items] of groups) {
      list.append(el('div', { class: 'conversation-group-label', text: label }));
      for (const conversation of items) {
        list.append(this.renderConversationItem(conversation));
      }
    }
  }

  private renderConversationItem(conversation: Conversation): HTMLElement {
    const wrapper = el('div', { class: 'conversation-row' });
    const button = el('div', {
      class: 'conversation-item',
      'aria-current': String(conversation.id === this.store.state.activeId),
    });
    // The row is a <div> containing two sibling buttons, not a button inside a
    // button: nested interactive elements are invalid HTML and break keyboard
    // focus order. The title button carries the "select" action.
    const selectButton = el('button', {
      type: 'button',
      class: 'conversation-item__select',
      title: conversation.title,
    });
    selectButton.append(el('span', { class: 'conversation-item__title', text: conversation.title }));

    const menuButton = el('button', {
      type: 'button',
      class: 'conversation-item__menu',
      'aria-label': `Actions for ${conversation.title}`,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    menuButton.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">${icons.more}</svg>`;
    menuButton.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openConversationMenu(conversation, menuButton);
    });
    selectButton.addEventListener('click', () => {
      this.store.selectConversation(conversation.id);
      this.renderThread();
      if (window.matchMedia('(max-width: 899px)').matches) this.store.setSidebarOpen(false);
    });

    button.append(selectButton, menuButton);
    wrapper.append(button);
    return wrapper;
  }

  private openConversationMenu(conversation: Conversation, anchor: HTMLElement): void {
    closeDropdown();
    anchor.setAttribute('aria-expanded', 'true');
    const rect = anchor.getBoundingClientRect();
    const menu = el('div', { class: 'dropdown', role: 'menu' });
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left - 120, window.innerWidth - 190))}px`;

    const rename = el('button', { type: 'button', class: 'dropdown__item', role: 'menuitem' });
    rename.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.edit}</svg><span>Rename</span>`;
    rename.addEventListener('click', () => {
      closeDropdown();
      this.promptRename(conversation);
    });

    const remove = el('button', { type: 'button', class: 'dropdown__item dropdown__item--danger', role: 'menuitem' });
    remove.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.trash}</svg><span>Delete</span>`;
    remove.addEventListener('click', () => {
      closeDropdown();
      this.deleteConversation(conversation);
    });

    menu.append(rename, el('div', { class: 'dropdown__separator' }), remove);
    document.body.append(menu);

    const onDocClick = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node) && event.target !== anchor) {
        closeDropdown();
      }
    };
    window.setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);

    function cleanup(): void {
      document.removeEventListener('mousedown', onDocClick);
      anchor.setAttribute('aria-expanded', 'false');
    }
    dropdownCleanup = cleanup;
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeDropdown();
    });
    (menu.firstElementChild as HTMLElement | null)?.focus();
  }

  private promptRename(conversation: Conversation): void {
    const dialog = openDialog({ title: 'Rename conversation', subtitle: 'Give this chat a clearer name.' });
    const form = el('form', { class: 'field' });
    const input = el('input', {
      class: 'input',
      type: 'text',
      value: conversation.title,
      maxlength: '120',
      'aria-label': 'Conversation title',
    }) as HTMLInputElement;
    form.append(el('label', { class: 'field__label', text: 'Title' }), input);
    dialog.body.append(form);
    dialog.footer.hidden = false;

    const cancel = el('button', { type: 'button', class: 'button button--ghost', text: 'Cancel' });
    cancel.addEventListener('click', () => dialog.close());
    const save = el('button', { type: 'button', class: 'button button--primary', text: 'Save' });
    save.addEventListener('click', () => {
      this.store.renameConversation(conversation.id, input.value);
      dialog.close();
      this.renderSidebar();
      showToast('Conversation renamed', { variant: 'success' });
    });
    dialog.footer.append(cancel, save);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        save.click();
      }
    });
    window.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  private deleteConversation(conversation: Conversation): void {
    const index = this.store.state.conversations.findIndex((item) => item.id === conversation.id);
    const removed = this.store.deleteConversation(conversation.id);
    if (!removed) return;
    this.renderThread();
    showToast('Conversation deleted', {
      action: {
        label: 'Undo',
        onClick: () => {
          this.store.restoreConversation(removed, Math.max(0, index));
          this.renderThread();
        },
      },
    });
  }

  /* ================================================================== */
  /* Thread                                                              */
  /* ================================================================== */

  private renderThread(): void {
    const thread = this.threadEl;
    clear(thread);
    this.emptyStateEl = null;
    this.currentAssistantEl = null;
    this.processingEl = null;
    this.streamingEl = null;

    const conversation = this.store.activeConversation;
    if (!conversation || conversation.messages.length === 0) {
      this.emptyStateEl = renderEmptyState({
        status: this.store.state.status,
        suggestions: this.store.state.suggestions,
        onSuggestion: (text) => {
          this.textareaEl.value = text;
          this.autoGrow();
          this.updateSendState();
          void this.sendCurrent();
        },
        onOpenSources: () => this.openSources(),
      });
      this.suggestionsEl = this.emptyStateEl;
      thread.append(this.emptyStateEl);
      this.suggestionsEl = this.emptyStateEl;
      this.scrollToBottom(true);
      this.updateComposerVisibility();
      return;
    }

    const callbacks = this.messageCallbacks();
    const messages = conversation.messages;
    messages.forEach((message, index) => {
      const isLast = index === messages.length - 1;
      if (message.role === 'user') {
        thread.append(renderUserMessage(message, callbacks));
      } else {
        const node = renderAssistantMessage(message, callbacks, {
          isLast,
          canRegenerate: !message.streaming,
        });
        if (isLast) this.currentAssistantEl = node;
        thread.append(node);
      }
    });

    this.updateComposerVisibility();
    this.scrollToBottom(true);
  }

  private messageCallbacks(): MessageCallbacks {
    return {
      onCopy: (text) => showToast(text, { variant: 'success' }),
      onRegenerate: (messageId) => void this.regenerate(messageId),
      onEditUser: (messageId) => this.editUserMessage(messageId),
      onOpenSource: (source) => void this.openSourceFile(source),
      onShowSourcePanel: (messageId, sourceId) => this.revealSource(messageId, sourceId),
      onFeedback: (messageId, value) => {
        this.store.setFeedback(messageId, value);
        showToast(value === 'up' ? 'Marked as helpful' : 'Marked as not helpful');
        this.renderThread();
      },
      feedbackFor: (messageId) => this.store.feedbackFor(messageId),
    };
  }

  private revealSource(messageId: string, sourceId: number): void {
    const panel = this.threadEl.querySelector<HTMLElement>(
      `.sources-panel[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!panel) return;
    const toggle = panel.querySelector<HTMLButtonElement>('.sources-panel__toggle');
    const list = panel.querySelector<HTMLUListElement>('.sources-list');
    if (toggle && list) {
      panel.dataset.open = 'true';
      toggle.setAttribute('aria-expanded', 'true');
      list.hidden = false;
    }
    const item = panel.querySelector<HTMLElement>(`.source-item[data-source-id="${sourceId}"]`);
    item?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    item?.animate?.(
      [
        { background: 'rgba(245,181,68,0.16)' },
        { background: 'transparent' },
      ],
      { duration: 1200, easing: 'ease-out' },
    );
  }

  private async openSourceFile(source: SourceRef): Promise<void> {
    const info = this.store.state.sources.find((item) => item.id === source.sourceId);
    if (!info) {
      showToast('That source has been removed.', { variant: 'error' });
      return;
    }
    openFileBrowser(info, {
      initialPath: source.path,
      highlightLines: { start: source.startLine, end: source.endLine },
    });
  }

  private editUserMessage(messageId: string): void {
    const conversation = this.store.activeConversation;
    if (!conversation) return;
    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message || message.role !== 'user') return;
    this.editingMessageId = messageId;
    this.textareaEl.value = message.content;
    this.autoGrow();
    this.updateSendState();
    this.textareaEl.focus();
    this.textareaEl.setSelectionRange(message.content.length, message.content.length);
    this.hintEl.innerHTML = `<span>Editing an earlier message — Enter sends and replaces the conversation from that point.</span>`;
  }

  /* ================================================================== */
  /* Sending / streaming                                                 */
  /* ================================================================== */

  private onComposerKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      // preventDefault also suppresses the form's implicit submission, so the
      // message is sent exactly once.
      event.preventDefault();
      event.stopPropagation();
      void this.sendCurrent();
      return;
    }
    if (event.key === 'Escape' && this.abortController) {
      event.preventDefault();
      this.stopGeneration();
    }
  }

  private autoGrow(): void {
    const textarea = this.textareaEl;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  }

  private updateSendState(): void {
    const hasText = this.textareaEl.value.trim().length > 0;
    const streaming = this.abortController !== null;
    this.sendButtonEl.disabled = !hasText || streaming;
    this.sendButtonEl.hidden = streaming;
    this.stopButtonEl.hidden = !streaming;
  }

  private updateComposerVisibility(): void {
    const conversation = this.store.activeConversation;
    const hasMessages = Boolean(conversation && conversation.messages.length > 0);
    this.hintEl.hidden = false;
    void hasMessages;
  }

  private async sendCurrent(): Promise<void> {
    const text = this.textareaEl.value.trim();
    if (text.length === 0 || this.abortController) return;
    if (this.editingMessageId) {
      const id = this.editingMessageId;
      this.editingMessageId = null;
      this.textareaEl.value = '';
      this.autoGrow();
      await this.retryFrom(id, text);
      return;
    }
    this.textareaEl.value = '';
    this.autoGrow();
    this.saveDraft();
    await this.sendMessage(text);
  }

  private async sendMessage(text: string): Promise<void> {
    let conversation = this.store.activeConversation;
    if (!conversation) conversation = this.store.createConversation();

    // If the previous turn was an empty new chat, populate the title.
    const userMessage: ChatMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    this.store.addMessage(conversation.id, userMessage);
    const assistantMessage: ChatMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      streaming: true,
      prompt: text,
    };
    this.store.addMessage(conversation.id, assistantMessage);
    this.lastPrompt = { conversationId: conversation.id, messageId: assistantMessage.id, text };

    this.emptyStateEl = null;
    this.renderThread();
    this.renderSidebar();
    this.beginStreaming(assistantMessage.id);

    const history = this.store.historyFor(conversation.id).slice(0, -1);
    await this.runStream({
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      message: text,
      history,
      sourceIds: this.store.state.sourceFilter,
    });
  }

  private beginStreaming(assistantMessageId: string): void {
    // Replace the placeholder assistant node with a live processing indicator.
    const node = this.currentAssistantEl;
    if (!node) return;
    const body = node.querySelector('.message__body');
    const indicator = new ProcessingIndicator();
    body?.replaceWith(indicator.element);
    this.processingEl = indicator;
    this.currentAssistantEl = node;
    node.dataset.streaming = 'true';
    void assistantMessageId;
    this.updateSendState();
    this.scrollToBottom();
  }

  private async runStream(params: {
    conversationId: string;
    messageId: string;
    message: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    sourceIds: string[];
    regenerate?: boolean;
  }): Promise<void> {
    const requestId = ++this.activeRequestId;
    this.abortController = new AbortController();
    this.updateSendState();
    this.streamingText = '';
    let stage: Stage = 'understanding';
    void stage;
    let receivedDelta = false;

    const handleEvent = (event: StreamEvent): void => {
      if (requestId !== this.activeRequestId) return;
      switch (event.type) {
        case 'stage': {
          stage = event.stage;
          this.processingEl?.setStage(event.stage, event.detail);
          break;
        }
        case 'meta': {
          this.processingEl?.setStage('evidence');
          break;
        }
        case 'sources': {
          // Sources arrive before the text; the final payload re-renders them.
          break;
        }
        case 'delta': {
          if (!receivedDelta) {
            receivedDelta = true;
            this.attachStreamingBody();
          }
          this.streamingText += event.text;
          if (this.streamingEl) {
            this.streamingEl.textContent = this.streamingText;
            const caret = el('span', { class: 'streaming-caret' });
            this.streamingEl.append(caret);
          }
          this.scrollToBottom();
          break;
        }
        case 'done': {
          this.finishAnswer(params.conversationId, params.messageId, event.answer);
          break;
        }
        case 'error': {
          this.failAnswer(params.conversationId, params.messageId, event.message, event.code, event.retryable);
          break;
        }
        default:
          break;
      }
    };

    await streamChat(
      {
        conversationId: params.conversationId,
        message: params.message,
        history: params.history,
        sourceIds: params.sourceIds,
        regenerate: params.regenerate,
      },
      {
        signal: this.abortController.signal,
        onEvent: handleEvent,
        onError: (error) => {
          if (requestId !== this.activeRequestId) return;
          this.failAnswer(params.conversationId, params.messageId, error.message, error.code, error.retryable);
        },
        onClose: () => {
          if (requestId !== this.activeRequestId) return;
          this.abortController = null;
          this.updateSendState();
          // A closed stream without a done event means it was stopped.
          const conversation = this.store.state.conversations.find((item) => item.id === params.conversationId);
          const message = conversation?.messages.find((item) => item.id === params.messageId);
          if (message?.streaming) {
            if (this.streamingText.length > 0) {
              this.store.updateMessage(params.conversationId, params.messageId, {
                content: this.streamingText,
                streaming: false,
              });
              this.renderThread();
              showToast('Generation stopped', { durationMs: 2000 });
            } else {
              this.store.updateMessage(params.conversationId, params.messageId, {
                streaming: false,
                error: { message: 'Generation was stopped before an answer was produced.', code: 'aborted', retryable: true },
              });
              this.renderThread();
            }
          }
        },
      },
    );
  }

  private attachStreamingBody(): void {
    const node = this.currentAssistantEl;
    if (!node) return;
    const indicator = node.querySelector('.processing');
    const body = el('div', { class: 'message__body md' });
    if (indicator) indicator.replaceWith(body);
    else if (!node.querySelector('.message__body')) node.append(body);
    this.streamingEl = body;
  }

  private finishAnswer(conversationId: string, messageId: string, answer: AnswerPayload): void {
    this.store.updateMessage(conversationId, messageId, {
      content: answer.text,
      answer,
      streaming: false,
      error: undefined,
    });
    this.abortController = null;
    this.updateSendState();
    this.renderThread();
    this.renderSidebar();
    this.renderComposerSources();
    this.scrollToBottom();
  }

  private failAnswer(
    conversationId: string,
    messageId: string,
    message: string,
    code: string,
    retryable: boolean,
  ): void {
    this.store.updateMessage(conversationId, messageId, {
      streaming: false,
      error: { message, code, retryable },
    });
    this.abortController = null;
    this.updateSendState();
    this.renderThread();
  }

  private stopGeneration(): void {
    if (!this.abortController) return;
    this.abortController.abort();
    this.abortController = null;
    this.updateSendState();
  }

  private async regenerate(assistantMessageId: string): Promise<void> {
    const conversation = this.store.activeConversation;
    if (!conversation) return;
    const index = conversation.messages.findIndex((message) => message.id === assistantMessageId);
    if (index < 0) return;
    const assistant = conversation.messages[index];
    const promptIndex = index - 1;
    const userMessage = conversation.messages[promptIndex];
    const prompt = assistant?.prompt ?? (userMessage?.role === 'user' ? userMessage.content : null);
    if (!prompt) {
      showToast('Cannot find the question for that answer.', { variant: 'error' });
      return;
    }
    // Drop the assistant turn (and anything after it), then re-ask.
    this.store.removeTrailingMessages(conversation.id, assistantMessageId);
    this.renderThread();
    await this.askAgain(conversation.id, prompt);
  }

  /** Re-asks a prompt, keeping the user turn that already exists. */
  private async askAgain(conversationId: string, prompt: string): Promise<void> {
    const assistantMessage: ChatMessage = {
      id: `msg_${crypto.randomUUID()}`,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      streaming: true,
      prompt,
    };
    this.store.addMessage(conversationId, assistantMessage);
    // The user turn already exists above this assistant placeholder.
    this.renderThread();
    this.beginStreaming(assistantMessage.id);
    const history = this.store.historyFor(conversationId).slice(0, -1);
    await this.runStream({
      conversationId,
      messageId: assistantMessage.id,
      message: prompt,
      history,
      sourceIds: this.store.state.sourceFilter,
      regenerate: true,
    });
  }

  /** Rewrites history from an earlier user message and re-asks it. */
  private async retryFrom(userMessageId: string, newText: string): Promise<void> {
    const conversation = this.store.activeConversation;
    if (!conversation) return;
    const index = conversation.messages.findIndex((message) => message.id === userMessageId);
    if (index < 0) return;
    const existing = conversation.messages[index] as ChatMessage;
    this.store.removeTrailingMessages(conversation.id, userMessageId);
    const edited: ChatMessage = { ...existing, content: newText, createdAt: new Date().toISOString() };
    this.store.addMessage(conversation.id, edited);
    this.renderThread();
    await this.askAgain(conversation.id, newText);
  }

  private scrollToBottom(force = false): void {
    if (!force && !this.isNearBottom) return;
    window.requestAnimationFrame(() => {
      this.scrollEl.scrollTop = this.scrollEl.scrollHeight;
      this.isNearBottom = true;
    });
  }

  /* ================================================================== */
  /* Composer sources + status                                           */
  /* ================================================================== */

  private renderComposerSources(): void {
    const row = this.sourcesRowEl;
    clear(row);
    const sources = this.store.state.sources.filter((source) => source.status === 'ready');
    if (sources.length === 0) {
      row.hidden = true;
      return;
    }
    row.hidden = sources.length < 2;
    if (sources.length < 2) return;

    const filter = this.store.state.sourceFilter;
    const allChip = el('button', {
      type: 'button',
      class: 'source-chip',
      'data-active': String(filter.length === 0),
      title: 'Search every source',
    });
    allChip.append(el('span', { text: 'All sources' }));
    allChip.addEventListener('click', () => this.store.setSourceFilter([]));
    row.append(allChip);

    for (const source of sources) {
      const chip = el('button', {
        type: 'button',
        class: 'source-chip',
        'data-active': String(filter.includes(source.id)),
        title: `Restrict search to ${source.name}`,
      });
      chip.append(el('span', { class: 'status-dot', 'data-status': 'ok' }), el('span', { text: source.name }));
      chip.addEventListener('click', () => {
        const next = filter.includes(source.id)
          ? filter.filter((id) => id !== source.id)
          : [...filter, source.id];
        this.store.setSourceFilter(next);
      });
      row.append(chip);
    }
  }

  private async refreshStatus(): Promise<void> {
    try {
      const status = await api.status();
      this.store.setStatus(status);
      this.store.setConnectionError(null);
      if (this.connectionRetryTimer !== null) {
        window.clearTimeout(this.connectionRetryTimer);
        this.connectionRetryTimer = null;
      }
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Cannot reach the server.';
      this.store.setConnectionError(message);
      if (this.connectionRetryTimer === null) {
        this.connectionRetryTimer = window.setTimeout(() => {
          this.connectionRetryTimer = null;
          void this.refreshStatus();
        }, 5000);
      }
    }
  }

  private async refreshSources(): Promise<void> {
    try {
      const { sources } = await api.sources();
      const previousIndexing = this.store.state.sources.some((source) => source.status === 'indexing');
      this.store.setSources(sources);
      this.renderComposerSources();
      const nowIndexing = sources.some((source) => source.status === 'indexing');
      if (previousIndexing && !nowIndexing) {
        showToast('Indexing finished', { variant: 'success' });
        this.renderThread();
      }
    } catch {
      // Status already surfaces connectivity problems.
    }
  }

  private async refreshSuggestions(): Promise<void> {
    try {
      const { suggestions } = await api.suggestions();
      this.store.setSuggestions(suggestions);
      const conversation = this.store.activeConversation;
      if (!conversation || conversation.messages.length === 0) this.renderThread();
    } catch {
      /* suggestions are cosmetic */
    }
  }

  private renderStatusBadge(): void {
    const status = this.store.state.status;
    const badge = this.statusBadgeEl;
    clear(badge);
    if (this.store.state.connectionError) {
      badge.dataset.mode = 'offline';
      badge.append(el('span', { class: 'status-dot', 'data-status': 'error' }), el('span', { text: 'Offline' }));
      badge.title = this.store.state.connectionError;
      return;
    }
    if (!status) {
      badge.dataset.mode = 'loading';
      badge.append(el('span', { class: 'status-dot', 'data-status': 'warn' }), el('span', { text: 'Connecting' }));
      return;
    }
    const mode = status.inference.mode;
    badge.dataset.mode = mode;
    const indexing = this.store.state.sources.some((source) => source.status === 'indexing');
    const label = indexing ? 'Indexing' : mode === 'inference' ? 'Inference' : 'Knowledge';
    badge.append(
      el('span', { class: 'status-dot', 'data-status': indexing ? 'warn' : 'ok' }),
      el('span', { text: label }),
    );
    badge.title = status.inference.reason;
  }

  /* ================================================================== */
  /* Dialogs                                                             */
  /* ================================================================== */

  private openSources(): void {
    openSourcesDialog({
      onSourcesChanged: () => {
        void this.refreshStatus();
        void this.refreshSources();
        void this.refreshSuggestions();
        this.renderThread();
      },
    });
  }

  private openStatusDialog(): void {
    const status = this.store.state.status;
    const dialog = openDialog({
      title: 'Engine status',
      subtitle: 'Exactly how IDOL AI is producing answers right now.',
    });
    const body = dialog.body;

    if (!status) {
      body.append(el('div', { class: 'search-empty', text: this.store.state.connectionError ?? 'Connecting to the server…' }));
      return;
    }

    const note = el('div', {
      class: `notice ${status.inference.mode === 'inference' ? 'notice--info' : 'notice--warning'}`,
    });
    note.innerHTML = `<span style="display:inline-flex"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${status.inference.mode === 'inference' ? icons.brain : icons.info}</svg></span>`;
    const noteBody = el('div', { class: 'notice__body' });
    noteBody.append(el('div', { class: 'notice__title', text: status.inference.mode === 'inference' ? 'Inference mode' : 'Knowledge mode' }));
    noteBody.append(el('div', { text: status.inference.reason }));
    note.append(noteBody);
    body.append(note);

    const stats = el('div', { class: 'stat-grid' });
    stats.append(
      stat(formatNumber(status.knowledge.totalPassages), 'passages'),
      stat(formatNumber(status.knowledge.totalFiles), 'files'),
      stat(String(status.knowledge.readySources), 'ready sources'),
      stat(formatBytes(status.knowledge.totalBytes), 'indexed'),
    );
    body.append(stats);

    const github = el('div', { class: 'field' });
    github.append(el('div', { class: 'section-title', text: 'GitHub' }));
    github.append(el('p', { class: 'field__hint', text: status.github.note }));
    body.append(github);

    const meta = el('div', { class: 'field' });
    meta.append(el('div', { class: 'section-title', text: 'Runtime' }));
    meta.append(
      el('p', {
        class: 'field__hint',
        text: `Version ${status.version} · uptime ${Math.floor(status.uptimeSeconds / 60)}m · last index ${relativeTime(
          status.knowledge.lastIndexedAt,
        )} · message limit ${formatNumber(status.limits.maxMessageChars)} chars · context budget ${formatNumber(
          status.limits.maxContextChars,
        )} chars`,
      }),
    );
    body.append(meta);

    dialog.footer.hidden = false;
    const refresh = el('button', { type: 'button', class: 'button button--secondary' });
    refresh.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons.refresh}</svg><span>Refresh</span>`;
    refresh.addEventListener('click', async () => {
      await this.refreshStatus();
      await this.refreshSources();
      dialog.close();
      this.openStatusDialog();
    });
    const sourcesButton = el('button', { type: 'button', class: 'button button--primary', text: 'Manage sources' });
    sourcesButton.addEventListener('click', () => {
      dialog.close();
      this.openSources();
    });
    dialog.footer.append(refresh, sourcesButton);
  }

  private openSearch(): void {
    const status = this.store.state.status;
    const dialog = openDialog({
      title: 'Search the repository index',
      subtitle: status
        ? `Lexical search across ${formatNumber(status.knowledge.totalPassages)} passages. This is the same retrieval engine the chat uses.`
        : 'Search across the indexed passages.',
      wide: true,
    });

    const form = el('form', { class: 'field' });
    const input = el('input', {
      class: 'input',
      type: 'search',
      placeholder: 'e.g. benchmark, vram, install, token',
      'aria-label': 'Search query',
      autocomplete: 'off',
    }) as HTMLInputElement;
    form.append(input);
    const results = el('div', { class: 'search-results' });
    dialog.body.append(form, results);
    this.searchDialogEl = results;

    const run = debounce(async () => {
      const query = input.value.trim();
      clear(results);
      if (query.length < 2) {
        results.append(el('div', { class: 'search-empty', text: 'Type at least two characters.' }));
        return;
      }
      results.append(el('div', { class: 'search-empty', text: 'Searching…' }));
      try {
        const response = await api.search(query, this.store.state.sourceFilter, 15);
        clear(results);
        if (response.hits.length === 0) {
          results.append(
            el('div', { class: 'search-empty', text: `No passage matched “${query}” in ${formatNumber(response.totalPassages)} indexed passages.` }),
          );
          return;
        }
        results.append(
          el('div', {
            class: 'field__hint',
            text: `${response.hits.length} result(s) in ${response.elapsedMs}ms`,
            style: 'margin-bottom:6px',
          }),
        );
        for (const hit of response.hits) {
          const button = el('button', { type: 'button', class: 'search-hit' });
          const top = el('div', { class: 'search-hit__top' });
          top.append(el('span', { class: 'search-hit__path', text: hit.path }));
          if (hit.heading) top.append(el('span', { class: 'search-hit__heading', text: `› ${hit.heading}` }));
          top.append(el('span', { class: 'search-hit__score', text: `L${hit.startLine}–${hit.endLine}` }));
          const excerpt = el('div', { class: 'search-hit__excerpt' });
          excerpt.innerHTML = highlightTerms(escapeHtml(hit.excerpt), query);
          button.append(top, excerpt);
          button.addEventListener('click', () => {
            const source = this.store.state.sources.find((item) => item.id === hit.sourceId);
            if (source) {
              dialog.close();
              openFileBrowser(source, {
                initialPath: hit.path,
                highlightLines: { start: hit.startLine, end: hit.endLine },
              });
            }
          });
          results.append(button);
        }
      } catch (error) {
        clear(results);
        results.append(
          el('div', { class: 'search-empty', text: error instanceof ApiError ? error.message : 'Search failed.' }),
        );
      }
    }, 260);

    input.addEventListener('input', () => run());
    run();
    window.requestAnimationFrame(() => input.focus());
  }

  private openShortcuts(): void {
    const dialog = openDialog({ title: 'Keyboard shortcuts', subtitle: 'Everything is reachable from the keyboard.' });
    const list = el('div', { class: 'kbd-list' });
    const rows: Array<[string, string]> = [
      ['Send message', 'Enter'],
      ['New line in composer', 'Shift + Enter'],
      ['Stop generating', 'Esc'],
      ['New chat', 'Ctrl / ⌘ + Shift + O'],
      ['Focus composer', '/'],
      ['Search repository', 'Ctrl / ⌘ + K'],
      ['Open sources', 'Ctrl / ⌘ + Shift + S'],
      ['Close dialog', 'Esc'],
    ];
    for (const [label, keys] of rows) {
      const row = el('div', { class: 'kbd-row' }, el('span', { text: label }), el('kbd', { text: keys }));
      list.append(row);
    }
    dialog.body.append(list);
  }

  private exportChats(): void {
    const payload = exportConversations();
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: `idol-ai-conversations-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Conversations exported', { variant: 'success' });
  }

  private toggleTheme(): void {
    const current = this.store.state.preferences.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    this.store.setPreferences({ theme: next });
    showToast(`${next === 'dark' ? 'Dark' : 'Light'} theme enabled`);
  }

  private startNewChat(): void {
    const conversation = this.store.activeConversation;
    // Reuse an empty conversation instead of stacking blanks.
    if (conversation && conversation.messages.length === 0) {
      this.renderThread();
      this.textareaEl.focus();
      if (window.matchMedia('(max-width: 899px)').matches) this.store.setSidebarOpen(false);
      return;
    }
    this.store.createConversation();
    this.renderThread();
    this.renderSidebar();
    if (window.matchMedia('(max-width: 899px)').matches) this.store.setSidebarOpen(false);
    this.textareaEl.focus();
  }

  /* ================================================================== */
  /* Global handlers                                                     */
  /* ================================================================== */

  private attachGlobalHandlers(): void {
    const on = <K extends keyof WindowEventMap>(
      target: Window,
      type: K,
      handler: (event: WindowEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ): void => {
      target.addEventListener(type, handler as EventListener, options);
      this.teardown.add(() => target.removeEventListener(type, handler as EventListener, options));
    };

    on(window, 'resize', debounce(() => this.renderSidebar(), 150));

    on(window, 'keydown', (event) => {
      const meta = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const inField = Boolean(
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
      );

      // Esc always means "get me out": stop a running answer, else close a dialog.
      if (event.key === 'Escape') {
        if (this.abortController) {
          event.preventDefault();
          this.stopGeneration();
        } else if (hasOpenDialog()) {
          event.preventDefault();
          closeAllDialogs();
        }
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        this.startNewChat();
        return;
      }
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.openSearch();
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        this.openSources();
        return;
      }
      if (!inField && event.key === '/') {
        event.preventDefault();
        this.textareaEl.focus();
      }
    });

    // Warn before losing an in-flight generation.
    on(window, 'beforeunload', (event) => {
      if (this.abortController) {
        event.preventDefault();
        event.returnValue = '';
      }
    });

    // Keep drafts so a refresh never loses typed text.
    const saveDraft = debounce(() => this.saveDraft(), 400);
    this.textareaEl.addEventListener('input', saveDraft);
    this.teardown.add(() => this.textareaEl.removeEventListener('input', saveDraft));

    // Follow the OS theme when the user chose "system".
    const scheme = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = (): void => {
      if (this.store.state.preferences.theme === 'system') {
        this.store.setPreferences({ theme: 'system' });
      }
    };
    scheme.addEventListener('change', onScheme);
    this.teardown.add(() => scheme.removeEventListener('change', onScheme));

    // Refresh sources when the tab regains focus (indexing may have finished).
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void this.refreshStatus();
        void this.refreshSources();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    this.teardown.add(() => document.removeEventListener('visibilitychange', onVisible));
  }

  private saveDraft(): void {
    try {
      const conversation = this.store.activeConversation;
      if (!conversation) return;
      if (this.textareaEl.value.trim().length > 0) {
        window.localStorage.setItem(`idol.draft.${conversation.id}`, this.textareaEl.value);
      } else {
        window.localStorage.removeItem(`idol.draft.${conversation.id}`);
      }
    } catch {
      /* storage full or blocked: drafts are a convenience only */
    }
  }

  private restoreDraft(): void {
    try {
      const conversation = this.store.activeConversation;
      if (!conversation) return;
      const draft = window.localStorage.getItem(`idol.draft.${conversation.id}`);
      if (draft) {
        this.textareaEl.value = draft;
        this.autoGrow();
        this.updateSendState();
      }
    } catch {
      /* ignore */
    }
  }

  /* ================================================================== */
  /* Small builders                                                      */
  /* ================================================================== */

  private iconButton(path: string, label: string, onClick: () => void): HTMLButtonElement {
    const button = el('button', { type: 'button', class: 'icon-button', 'aria-label': label, title: label });
    button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    button.addEventListener('click', onClick);
    return button;
  }

  private sidebarLink(path: string, label: string, onClick: () => void, action?: string): HTMLButtonElement {
    const button = el('button', { type: 'button', class: 'sidebar-link' });
    if (action) button.dataset.sidebarAction = action;
    button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg><span></span><span class="sidebar-link__meta"></span>`;
    const text = button.querySelector('span');
    if (text) text.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }
}

/* ------------------------------------------------------------------ */
/* Module helpers                                                      */
/* ------------------------------------------------------------------ */

let dropdownCleanup: (() => void) | null = null;

function closeDropdown(): void {
  for (const node of $$('.dropdown')) node.remove();
  dropdownCleanup?.();
  dropdownCleanup = null;
}

function stat(value: string, label: string): HTMLElement {
  const node = el('div', { class: 'stat' });
  node.append(el('div', { class: 'stat__value', text: value }), el('div', { class: 'stat__label', text: label }));
  return node;
}

function groupLabel(timestamp: number, now: number): string {
  const day = 86_400_000;
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday) return 'Today';
  if (timestamp >= startOfToday - day) return 'Yesterday';
  if (timestamp >= now - 7 * day) return 'Previous 7 days';
  if (timestamp >= now - 30 * day) return 'Previous 30 days';
  return 'Older';
}

function highlightTerms(escapedHtml: string, query: string): string {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/[^\w-]/g, ''))
    .filter((term) => term.length > 2)
    .slice(0, 6);
  if (terms.length === 0) return escapedHtml;
  let output = escapedHtml;
  for (const term of terms) {
    const pattern = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    output = output.replace(pattern, '<mark>$1</mark>');
  }
  return output;
}

export { deriveTitle };
