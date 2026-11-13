import { splitSse } from './sse.mjs';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...options,
      credentials: 'include',
      headers: {
        ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError('KAVRON API is offline. Start the backend and retry.', 0);
  }
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('application/json') ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const detail = typeof body?.detail === 'string' ? body.detail : `Request failed (${response.status}).`;
    throw new ApiError(detail, response.status);
  }
  return body as T;
}

export type ChatEvent =
  | { type: 'meta'; conversation_id: string; user_message_id?: string; model: string; provider: string; repository_knowledge?: 'disabled' | 'available' | 'no_matches' | 'unavailable'; repository_coverage?: Record<string, unknown> | null }
  | { type: 'sources'; items: { path: string; url: string; score: number }[] }
  | { type: 'delta'; content: string }
  | { type: 'done'; message_id: string }
  | { type: 'error'; message: string };

export async function streamChat(
  payload: { message: string; conversation_id?: string; project_id?: string; provider?: string; model?: string; file_ids?: string[]; use_repository_knowledge?: boolean; repository_ref?: string; edit_message_id?: string; image_context?: string },
  signal: AbortSignal,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/v1/chat/stream', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw new ApiError('Could not reach the KAVRON API. Check your connection and retry.', 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(typeof data?.detail === 'string' ? data.detail : `Request failed (${response.status}).`, response.status);
  }
  if (!response.body) throw new ApiError('Streaming is unavailable in this browser.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const parsed = splitSse(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.events) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice(5).trim()) as ChatEvent);
      } catch {
        // Ignore malformed provider frames without breaking the stream parser.
      }
    }
    if (done) break;
  }
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'user';
  created_at: string;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  model?: string | null;
  created_at?: string;
  sources?: { path: string; url: string; score: number }[];
}
export interface Conversation {
  id: string;
  title: string;
  project_id: string | null;
  updated_at: string;
  preview?: string | null;
}
export interface Project {
  id: string;
  name: string;
  description: string;
  instructions: string;
  default_provider_id?: string | null;
  default_model?: string;
  conversation_count?: number;
  updated_at: string;
}
export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  provider: string;
  model: string;
  enabled_engines: string[];
  visibility: 'private' | 'workspace';
  max_steps: number;
  updated_at: string;
}
export interface ModelInfo {
  id: string;
  provider: string;
  capabilities: string[];
}
export interface ProviderInfo {
  id: string;
  name: string;
  provider?: string;
  configured: boolean;
  healthy: boolean;
  error: string | null;
  model_count: number;
  base_url?: string;
  model?: string;
  context_length?: number;
  capabilities?: string[];
  vision_model?: string;
  image_model?: string;
  embedding_model?: string;
  fallback_priority?: number;
  enabled?: boolean;
}
export interface EngineInfo {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  configured: boolean;
  state: string;
  detail: string;
}
