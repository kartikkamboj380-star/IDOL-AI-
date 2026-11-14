/**
 * What the answer engine needs from a model, expressed without any transport.
 *
 * `InferenceAdapter` lives in provider.ts next to the HTTP client that talks to
 * OpenAI-compatible endpoints, and importing that file from a browser bundle
 * drags in `node:https` through `util/http`. The engine only ever needs the shape,
 * so it depends on this file instead: types plus one error class, no imports.
 */
import type { InferenceStatus } from '../../shared/types.js';

/**
 * The provider reports availability without deciding presentation; the engine
 * adds `mode`. Kept structural so both shapes satisfy it.
 */
export type AdapterStatus = Pick<InferenceStatus, 'available' | 'provider' | 'model' | 'reason'>;

export interface PromptInput {
  question: string;
  contextText: string;
  historyTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
  intent: string;
  sourcesList: string;
}

export interface GenerateInput {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface GenerateResult {
  text: string;
  provider: string;
  model: string;
}

/** The surface the answer engine calls. Implemented by the real adapter. */
export interface ModelAdapter {
  status(): AdapterStatus;
  buildPrompt(input: PromptInput): { system: string; user: string };
  generate(input: GenerateInput): Promise<GenerateResult>;
}

/** Thrown when the configured provider is unreachable or misbehaves. */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}
