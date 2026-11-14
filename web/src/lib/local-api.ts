/**
 * The same `api` surface the UI already uses, served entirely from the device.
 *
 * The browser bundle contains one question: is there a server? In `npm run dev`
 * and on a self-hosted deployment there is, and `lib/api.ts` talks to it over
 * HTTP. In the Android build there is not, and the UI would otherwise show
 * "Could not reach the IDOL AI server" forever.
 *
 * Rather than fork every screen, the app picks an implementation at startup.
 * Both satisfy `ApiSurface`, so a screen cannot accidentally depend on one.
 */
import type {
  AppStatus,
  FileResponse,
  GitHubConnection,
  KnowledgeSource,
  RepoTreeEntry,
  SearchHit,
  StreamEvent,
} from '../types.js';
import type { ApiError } from './api.js';
import type { ChunkKind } from '../../../shared/types.js';
import { LocalBrain, type LocalSource } from './local-brain.js';
import { languageFor, parseFile } from '../../../server/knowledge/file-types.js';
import { documentStore, restoreInto } from './local-store.js';

export interface ChatStreamHandlers {
  onEvent: (event: StreamEvent) => void;
  onError: (error: ApiError) => void;
  onClose: () => void;
  signal?: AbortSignal;
}

export interface ChatRequestBody {
  conversationId: string;
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  sourceIds?: string[];
  regenerate?: boolean;
}

/** What a screen may call. Implemented over HTTP and over the local brain. */
export interface ApiSurface {
  status(): Promise<AppStatus>;
  suggestions(): Promise<{ suggestions: string[]; sources: number }>;
  sources(): Promise<{ sources: KnowledgeSource[] }>;
  addSource(body: { kind: 'github'; repository: string; ref?: string; name?: string }): Promise<{ source: KnowledgeSource }>;
  addDocuments(body: { name: string; docs: Array<{ path: string; text: string }> }): Promise<{ source: KnowledgeSource; skipped: Array<{ path: string; reason: string }> }>;
  reindexSource(id: string, force?: boolean): Promise<{ source: KnowledgeSource }>;
  removeSource(id: string): Promise<{ ok: boolean }>;
  tree(id: string, path?: string): Promise<{ sourceId: string; path: string; entries: RepoTreeEntry[]; truncated: boolean }>;
  file(id: string, path: string): Promise<FileResponse>;
  search(query: string, sourceIds?: string[], limit?: number): Promise<{ query: string; totalPassages: number; elapsedMs: number; hits: SearchHit[] }>;
  github(): Promise<GitHubConnection>;
  saveToken(token: string): Promise<{ ok: boolean; login: string; scopes: string | null }>;
  removeToken(): Promise<{ ok: boolean }>;
  /** True when this surface needs a server. The local one needs nothing. */
  readonly requiresServer: boolean;
}

/* ------------------------------------------------------------------ */
/* Local implementation                                               */
/* ------------------------------------------------------------------ */

const NO_GITHUB: GitHubConnection = {
  authenticated: false,
  tokenSource: 'none',
  login: null,
  scopes: null,
  envManaged: false,
  rateLimit: null,
};

const NO_GITHUB_NOTE =
  'This app runs entirely on your device. There is no GitHub token to manage: documents you load stay on the phone.';

/** The real parser decides the kind, so file previews match the index. */
function kindFor(path: string, text: string): ChunkKind {
  const parsed = parseFile(path, text.slice(0, 2000));
  return parsed.ok ? parsed.kind : 'text';
}

/** Rebuilds the local error type without importing the HTTP client's module. */
function localError(message: string, code: string): ApiError {
  const error = new Error(message) as ApiError;
  error.name = 'ApiError';
  Object.defineProperty(error, 'code', { value: code, enumerable: true });
  Object.defineProperty(error, 'status', { value: 0, enumerable: true });
  Object.defineProperty(error, 'retryable', { value: false, enumerable: true });
  return error;
}

export class LocalApi implements ApiSurface {
  readonly requiresServer = false;
  private readonly brain = new LocalBrain();
  private readonly startedAt = Date.now();
  private loaded = false;
  private loading: Promise<void> | null = null;

  /** Replays saved documents into the brain. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loading ??= restoreInto(this.brain).then((stored) => {
      this.loaded = true;
      void stored;
    });
    await this.loading;
  }

  private toSource(storedId: string, name: string, docCount: number, addedAt: string): KnowledgeSource {
    return {
      id: storedId,
      kind: 'local',
      name,
      status: 'ready',
      lastIndexedAt: addedAt,
      filesIndexed: docCount,
      addedAt,
    };
  }

  async status(): Promise<AppStatus> {
    await this.init();
    const stats = this.brain.stats();
    return {
      ok: true,
      version: '1.1.0',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      inference: {
        available: false,
        provider: null,
        model: null,
        reason:
          'On-device app: answers are extractive summaries of the documents you loaded. No language model is configured, so no sentence is invented.',
        mode: 'knowledge',
      },
      knowledge: {
        totalSources: stats.sources,
        readySources: stats.sources,
        totalFiles: stats.files,
        totalPassages: stats.passages,
        totalBytes: stats.bytes,
        lastIndexedAt: stats.sources > 0 ? new Date().toISOString() : null,
        byStatus: {},
      } as AppStatus['knowledge'],
      github: { authenticated: false, note: NO_GITHUB_NOTE },
      limits: {
        maxMessageChars: 4000,
        maxFilesPerSource: 400,
        maxFileBytes: 400_000,
        maxContextChars: 12_000,
      },
    } as AppStatus;
  }

  async suggestions(): Promise<{ suggestions: string[]; sources: number }> {
    await this.init();
    const stats = this.brain.stats();
    if (stats.passages === 0) {
      return { suggestions: ['What can you do?', 'How do I add my documents?'], sources: 0 };
    }
    return {
      suggestions: [
        'What is this project about?',
        'How do I install it?',
        'What are the requirements?',
        'Show me the main components',
        'How do I run the tests?',
      ],
      sources: stats.sources,
    };
  }

  async sources(): Promise<{ sources: KnowledgeSource[] }> {
    await this.init();
    const stored = await documentStore().list();
    return {
      sources: stored.map((source) => this.toSource(source.id, source.name, source.docs.length, source.addedAt)),
    };
  }

  async addSource(): Promise<{ source: KnowledgeSource }> {
    // Fetching a repository needs a network; the device build has none by design.
    throw localError(
      'This app runs without a network. Add documents from your phone storage instead, or use the desktop build to index a GitHub repository.',
      'offline_build',
    );
  }

  async addDocuments(body: { name: string; docs: Array<{ path: string; text: string }> }): Promise<{
    source: KnowledgeSource;
    skipped: Array<{ path: string; reason: string }>;
  }> {
    await this.init();
    if (body.docs.length === 0) throw localError('No readable text files were selected.', 'empty_source');

    const id = `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const source: LocalSource = { id, name: body.name, docs: body.docs };
    const result = this.brain.load(source);
    const addedAt = new Date().toISOString();

    if (result.indexed === 0) {
      this.brain.remove(id);
      throw localError(
        `None of those files could be read. ${result.skipped[0]?.reason ?? ''}`.trim(),
        'unreadable_source',
      );
    }

    await documentStore().put({ id, name: body.name, addedAt, docs: body.docs });
    return {
      source: this.toSource(id, body.name, result.indexed, addedAt),
      skipped: result.skipped,
    };
  }

  async reindexSource(id: string): Promise<{ source: KnowledgeSource }> {
    await this.init();
    const stored = await documentStore().list();
    const match = stored.find((source) => source.id === id);
    if (!match) throw localError('That document set is no longer stored.', 'not_found');
    this.brain.load({ id: match.id, name: match.name, docs: match.docs });
    return { source: this.toSource(match.id, match.name, match.docs.length, new Date().toISOString()) };
  }

  async removeSource(id: string): Promise<{ ok: boolean }> {
    await this.init();
    this.brain.remove(id);
    await documentStore().delete(id);
    return { ok: true };
  }

  async tree(id: string, path = ''): Promise<{ sourceId: string; path: string; entries: RepoTreeEntry[]; truncated: boolean }> {
    await this.init();
    const stored = await documentStore().list();
    const match = stored.find((source) => source.id === id);
    if (!match) throw localError('That document set is no longer stored.', 'not_found');

    const prefix = path ? `${path.replace(/\/$/, '')}/` : '';
    const seen = new Set<string>();
    const entries: RepoTreeEntry[] = [];
    for (const doc of match.docs) {
      if (!doc.path.startsWith(prefix)) continue;
      const rest = doc.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (!seen.has(rest)) {
          seen.add(rest);
          entries.push({ path: `${prefix}${rest}`, type: 'file', size: doc.text.length });
        }
      } else {
        const dir = `${prefix}${rest.slice(0, slash)}`;
        if (!seen.has(dir)) {
          seen.add(dir);
          entries.push({ path: dir, type: 'dir' });
        }
      }
    }
    entries.sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.path.localeCompare(b.path));
    return { sourceId: id, path, entries, truncated: false };
  }

  async file(id: string, path: string): Promise<FileResponse> {
    await this.init();
    const stored = await documentStore().list();
    const match = stored.find((source) => source.id === id);
    const doc = match?.docs.find((item) => item.path === path);
    if (!match || !doc) throw localError('That file is not part of the loaded documents.', 'not_found');
    return {
      sourceId: id,
      path,
      language: languageFor(path),
      kind: kindFor(path, doc.text),
      size: doc.text.length,
      content: doc.text,
      truncated: false,
      htmlUrl: null,
      citations: 0,
    };
  }

  async search(query: string, sourceIds: string[] = [], limit = 12): Promise<{
    query: string;
    totalPassages: number;
    elapsedMs: number;
    hits: SearchHit[];
  }> {
    await this.init();
    const started = Date.now();
    const result = this.brain.search(query, { sourceIds, limit });
    return { query, totalPassages: this.brain.stats().passages, elapsedMs: Date.now() - started, hits: result };
  }

  async github(): Promise<GitHubConnection> {
    return NO_GITHUB;
  }

  async saveToken(): Promise<{ ok: boolean; login: string; scopes: string | null }> {
    throw localError('This app has no network, so a GitHub token would have nothing to talk to.', 'offline_build');
  }

  async removeToken(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async streamChat(body: ChatRequestBody, handlers: ChatStreamHandlers): Promise<void> {
    await this.init();
    try {
      // The brain emits the same `done` event the SSE route does, so the UI's
      // existing stream handler needs no changes.
      await this.brain.ask({
        question: body.message,
        conversationId: body.conversationId,
        history: body.history,
        emit: handlers.onEvent,
        signal: handlers.signal,
      });
    } catch (error) {
      if (handlers.signal?.aborted) {
        handlers.onClose();
        return;
      }
      handlers.onError(localError(error instanceof Error ? error.message : 'The answer could not be produced.', 'local_error'));
      return;
    }
    handlers.onClose();
  }
}
