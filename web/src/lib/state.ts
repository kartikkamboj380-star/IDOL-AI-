/**
 * Application state and conversation operations.
 *
 * Kept framework-free and small: a plain object of state plus explicit
 * mutations that persist through `storage.ts`. Rendering is driven by the
 * controller in `app.ts`, which subscribes to `onChange`.
 */
import type { AppStatus, ChatMessage, Conversation, Preferences, KnowledgeSource } from '../types.js';
import {
  applyTheme,
  loadConversations,
  loadPreferences,
  saveConversations,
  savePreferences,
} from './storage.js';

export interface FeedbackRecord {
  messageId: string;
  value: 'up' | 'down';
  at: string;
}

export interface AppState {
  conversations: Conversation[];
  activeId: string | null;
  status: AppStatus | null;
  sources: KnowledgeSource[];
  suggestions: string[];
  preferences: Preferences;
  sidebarOpen: boolean;
  sourceFilter: string[];
  feedback: Map<string, 'up' | 'down'>;
  connectionError: string | null;
}

type Listener = () => void;

export class Store {
  private readonly listeners = new Set<Listener>();
  readonly state: AppState;

  constructor() {
    const conversations = loadConversations();
    const preferences = loadPreferences();
    applyTheme(preferences.theme);
    this.state = {
      conversations,
      activeId: conversations[0]?.id ?? null,
      status: null,
      sources: [],
      suggestions: [],
      preferences,
      sidebarOpen: false,
      sourceFilter: [],
      feedback: new Map(),
      connectionError: null,
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  /* ---------------------------------------------------------------- */
  /* Conversations                                                     */
  /* ---------------------------------------------------------------- */

  get activeConversation(): Conversation | null {
    if (!this.state.activeId) return null;
    return this.state.conversations.find((conversation) => conversation.id === this.state.activeId) ?? null;
  }

  createConversation(): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: `conv_${crypto.randomUUID()}`,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.conversations.unshift(conversation);
    this.state.activeId = conversation.id;
    this.persist();
    this.notify();
    return conversation;
  }

  selectConversation(id: string): void {
    if (!this.state.conversations.some((conversation) => conversation.id === id)) return;
    this.state.activeId = id;
    this.notify();
  }

  renameConversation(id: string, title: string): void {
    const conversation = this.state.conversations.find((item) => item.id === id);
    if (!conversation) return;
    const trimmed = title.trim().slice(0, 120);
    conversation.title = trimmed.length > 0 ? trimmed : 'Untitled chat';
    conversation.updatedAt = new Date().toISOString();
    this.persist();
    this.notify();
  }

  deleteConversation(id: string): Conversation | null {
    const index = this.state.conversations.findIndex((conversation) => conversation.id === id);
    if (index < 0) return null;
    const [removed] = this.state.conversations.splice(index, 1);
    if (this.state.activeId === id) {
      this.state.activeId = this.state.conversations[0]?.id ?? null;
    }
    this.persist();
    this.notify();
    return removed ?? null;
  }

  restoreConversation(conversation: Conversation, atIndex = 0): void {
    this.state.conversations.splice(atIndex, 0, conversation);
    this.state.activeId = conversation.id;
    this.persist();
    this.notify();
  }

  /** Appends a message and derives a title from the first user message. */
  addMessage(conversationId: string, message: ChatMessage): void {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    conversation.messages.push(message);
    conversation.updatedAt = new Date().toISOString();
    if (conversation.title === 'New chat' && message.role === 'user') {
      conversation.title = deriveTitle(message.content);
    }
    this.persist();
  }

  updateMessage(conversationId: string, messageId: string, patch: Partial<ChatMessage>): void {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const message = conversation.messages.find((item) => item.id === messageId);
    if (!message) return;
    Object.assign(message, patch);
    conversation.updatedAt = new Date().toISOString();
    this.persist();
  }

  removeTrailingMessages(conversationId: string, fromMessageId: string): void {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return;
    const index = conversation.messages.findIndex((message) => message.id === fromMessageId);
    if (index < 0) return;
    conversation.messages.splice(index);
    conversation.updatedAt = new Date().toISOString();
    this.persist();
    this.notify();
  }

  /** History window sent to the server for memory (bounded, text only). */
  historyFor(conversationId: string, limit = 8): Array<{ role: 'user' | 'assistant'; content: string }> {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) return [];
    return conversation.messages
      .filter((message) => !message.error && message.content.trim().length > 0)
      .slice(-limit)
      .map((message) => ({
        role: message.role,
        content: message.role === 'assistant' && message.answer ? message.answer.text.slice(0, 1200) : message.content,
      }));
  }

  /* ---------------------------------------------------------------- */
  /* Preferences / chrome                                              */
  /* ---------------------------------------------------------------- */

  setPreferences(patch: Partial<Preferences>): void {
    this.state.preferences = { ...this.state.preferences, ...patch };
    savePreferences(this.state.preferences);
    applyTheme(this.state.preferences.theme);
    this.notify();
  }

  setSidebarOpen(open: boolean): void {
    this.state.sidebarOpen = open;
    this.notify();
  }

  setSourceFilter(ids: string[]): void {
    this.state.sourceFilter = ids;
    this.notify();
  }

  setStatus(status: AppStatus): void {
    this.state.status = status;
    this.notify();
  }

  setSources(sources: KnowledgeSource[]): void {
    this.state.sources = sources;
    // Drop filters that point at sources which no longer exist.
    const valid = new Set(sources.map((source) => source.id));
    this.state.sourceFilter = this.state.sourceFilter.filter((id) => valid.has(id));
    this.notify();
  }

  setSuggestions(suggestions: string[]): void {
    this.state.suggestions = suggestions;
    this.notify();
  }

  setConnectionError(message: string | null): void {
    this.state.connectionError = message;
    this.notify();
  }

  setFeedback(messageId: string, value: 'up' | 'down'): void {
    this.state.feedback.set(messageId, value);
    this.notify();
  }

  feedbackFor(messageId: string): 'up' | 'down' | null {
    return this.state.feedback.get(messageId) ?? null;
  }

  private persist(): void {
    saveConversations(this.state.conversations);
  }
}

export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'New chat';
  const firstSentence = cleaned.split(/[.?!]/)[0] ?? cleaned;
  const title = firstSentence.length > 52 ? `${firstSentence.slice(0, 49).trimEnd()}…` : firstSentence;
  return title.length > 0 ? title : 'New chat';
}
