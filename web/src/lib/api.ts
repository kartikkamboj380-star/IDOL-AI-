/**
 * API client. All requests are same-origin relative paths, so no CORS
 * configuration or token handling ever touches the browser.
 */
import { ApiError } from './api-error.js';
import type {
  ApiErrorBody,
  AppStatus,
  FileResponse,
  GitHubConnection,
  KnowledgeSource,
  RepoTreeEntry,
  SearchHit,
  StreamEvent,
} from '../types.js';

// Defined in api-error.ts so the device build can use it without pulling in the
// fetch layer; re-exported so existing imports keep working.
export { ApiError } from './api-error.js';

async function requestJson<T>(path: string, init: RequestInit = {}, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal,
      credentials: 'same-origin',
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) {
      const error = (body as ApiErrorBody | null)?.error;
      throw new ApiError(
        error?.message ?? `Request failed (${response.status}).`,
        error?.code ?? 'http_error',
        response.status,
        error?.retryable ?? response.status >= 500,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('The request timed out. The server may still be indexing.', 'timeout', 0, true);
    }
    throw new ApiError(
      navigator.onLine ? 'Could not reach the IDOL AI server. Is it running?' : 'You appear to be offline.',
      'network_error',
      0,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  status: () => requestJson<AppStatus>('/api/status'),
  suggestions: () => requestJson<{ suggestions: string[]; sources: number }>('/api/suggestions'),

  sources: () => requestJson<{ sources: KnowledgeSource[] }>('/api/sources'),
  addSource: (body: { kind: 'github'; repository: string; ref?: string; name?: string }) =>
    requestJson<{ source: KnowledgeSource }>('/api/sources', { method: 'POST', body: JSON.stringify(body) }),
  reindexSource: (id: string, force = false) =>
    requestJson<{ source: KnowledgeSource }>(`/api/sources/${encodeURIComponent(id)}/reindex${force ? '?force=1' : ''}`, {
      method: 'POST',
    }),
  removeSource: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  tree: (id: string, path = '') =>
    requestJson<{ sourceId: string; path: string; entries: RepoTreeEntry[]; truncated: boolean }>(
      `/api/sources/${encodeURIComponent(id)}/tree?path=${encodeURIComponent(path)}`,
    ),
  file: (id: string, path: string) =>
    requestJson<FileResponse>(
      `/api/sources/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
      {},
      120_000,
    ),

  search: (query: string, sourceIds: string[] = [], limit = 12) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (sourceIds.length > 0) params.set('sources', sourceIds.join(','));
    return requestJson<{ query: string; totalPassages: number; elapsedMs: number; hits: SearchHit[] }>(
      `/api/search?${params.toString()}`,
    );
  },

  github: () => requestJson<GitHubConnection>('/api/github'),
  saveToken: (token: string) =>
    requestJson<{ ok: boolean; login: string; scopes: string | null }>('/api/github/token', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  removeToken: () => requestJson<{ ok: boolean }>('/api/github/token', { method: 'DELETE' }),
};

/* ------------------------------------------------------------------ */
/* Chat streaming                                                      */
/* ------------------------------------------------------------------ */

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

/**
 * Streams `/api/chat` over SSE.
 *
 * fetch() is used rather than EventSource because the request has a JSON body
 * and must be abortable. Partial frames are buffered until a blank line.
 */
export async function streamChat(body: ChatRequestBody, handlers: ChatStreamHandlers): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: handlers.signal,
      credentials: 'same-origin',
    });
  } catch (error) {
    if (handlers.signal?.aborted) {
      handlers.onClose();
      return;
    }
    handlers.onError(
      new ApiError(
        navigator.onLine ? 'Could not reach the server to send that message.' : 'You are offline.',
        'network_error',
        0,
        true,
      ),
    );
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `The server rejected the request (${response.status}).`;
    let code = 'http_error';
    let retryable = response.status >= 500;
    try {
      const parsed = JSON.parse(text) as ApiErrorBody;
      if (parsed.error) {
        message = parsed.error.message;
        code = parsed.error.code;
        retryable = parsed.error.retryable;
      }
    } catch {
      /* keep defaults */
    }
    handlers.onError(new ApiError(message, code, response.status, retryable));
    return;
  }

  if (!response.body) {
    handlers.onError(new ApiError('The server returned an empty response.', 'empty_stream', 0, true));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf('\n\n');
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf('\n\n');
        const dataLines = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) continue;
        const payload = dataLines.join('\n');
        try {
          const event = JSON.parse(payload) as StreamEvent;
          handlers.onEvent(event);
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  } catch (error) {
    if (!handlers.signal?.aborted) {
      handlers.onError(new ApiError('The connection to the server was interrupted.', 'stream_error', 0, true));
    }
  } finally {
    handlers.onClose();
  }
}
