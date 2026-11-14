/**
 * Local-first persistence.
 *
 * Conversations never leave the browser: they are stored in localStorage (with
 * an in-memory fallback when storage is unavailable, e.g. private mode). The
 * server is stateless, so a cleared browser simply means a cleared history.
 */
import type { Conversation, Preferences } from '../types.js';

const CONVERSATIONS_KEY = 'idol.conversations.v1';
const PREFERENCES_KEY = 'idol.preferences.v1';
const MAX_CONVERSATIONS = 200;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function resolveStorage(): StorageLike {
  try {
    const probe = '__idol_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
}

const storage = resolveStorage();

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

export function loadConversations(): Conversation[] {
  const raw = readJson<unknown>(CONVERSATIONS_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isConversation).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    Array.isArray(record.messages)
  );
}

export function saveConversations(conversations: Conversation[]): void {
  // Cap history so storage quota is never exhausted; oldest conversations drop.
  const trimmed = conversations
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CONVERSATIONS)
    .map(stripTransientState);
  const ok = writeJson(CONVERSATIONS_KEY, trimmed);
  if (!ok) {
    // Quota exceeded: retry with a much smaller set rather than losing everything.
    writeJson(CONVERSATIONS_KEY, trimmed.slice(0, 40));
  }
}

/** Streaming flags and errors are runtime-only; never persist them. */
function stripTransientState(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => {
      const { streaming, ...rest } = message;
      void streaming;
      return rest;
    }),
  };
}

export function exportConversations(): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      app: 'IDOL AI',
      conversations: loadConversations(),
    },
    null,
    2,
  );
}

export function clearConversations(): void {
  storage.removeItem(CONVERSATIONS_KEY);
}

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

const DEFAULT_PREFERENCES: Preferences = { theme: 'system', sidebarCollapsed: false };

export function loadPreferences(): Preferences {
  const raw = readJson<Partial<Preferences>>(PREFERENCES_KEY, {});
  return {
    theme: raw.theme === 'dark' || raw.theme === 'light' || raw.theme === 'system' ? raw.theme : DEFAULT_PREFERENCES.theme,
    sidebarCollapsed: typeof raw.sidebarCollapsed === 'boolean' ? raw.sidebarCollapsed : DEFAULT_PREFERENCES.sidebarCollapsed,
  };
}

export function savePreferences(preferences: Preferences): void {
  writeJson(PREFERENCES_KEY, preferences);
}

export function resolveTheme(theme: Preferences['theme']): 'dark' | 'light' {
  if (theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return theme;
}

export function applyTheme(theme: Preferences['theme']): void {
  const resolved = resolveTheme(theme);
  document.documentElement.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'light' ? '#fbfaf8' : '#0a0a0c');
}
