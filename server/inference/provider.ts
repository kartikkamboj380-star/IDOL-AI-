/**
 * Inference adapter.
 *
 * IDOL AI works with zero AI credentials: in that case the app runs in
 * "knowledge mode" and never pretends to reason. If the operator configures an
 * OpenAI-compatible chat-completions endpoint (Groq, Together, OpenRouter,
 * Ollama, vLLM, LM Studio, OpenAI, ...), this adapter performs real grounded
 * generation and the UI labels answers as inference mode.
 *
 * The adapter is deliberately small: one POST, streaming SSE parsing, hard
 * timeouts, and errors that degrade to knowledge mode instead of failing the
 * chat.
 */
import { AppError } from '../util/errors.js';
import { HttpError, request } from '../util/http.js';
import type { Logger } from '../logger.js';

export interface InferenceStatusInternal {
  available: boolean;
  provider: string | null;
  model: string | null;
  reason: string;
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
  model: string;
  provider: string;
}

export class InferenceError extends AppError {
  constructor(message: string, readonly fallbackHint: string) {
    super('inference_error', message, 502, true);
  }
}

export class InferenceAdapter {
  private lastError: string | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly config: {
      provider: string | null;
      baseUrl: string | null;
      apiKey: string | null;
      model: string | null;
      timeoutMs: number;
    },
    private readonly logger: Logger,
  ) {}

  status(): InferenceStatusInternal {
    const { baseUrl, model } = this.config;
    if (!baseUrl || !model) {
      return {
        available: false,
        provider: null,
        model: null,
        reason:
          'No inference provider is configured, so IDOL AI runs in knowledge mode: answers are extractive summaries of retrieved repository passages, with exact citations.',
      };
    }
    if (this.consecutiveFailures >= 3) {
      return {
        available: false,
        provider: this.config.provider ?? 'openai-compatible',
        model,
        reason: `The inference provider failed ${this.consecutiveFailures} times in a row (${this.lastError ?? 'unknown error'}); IDOL AI fell back to knowledge mode.`,
      };
    }
    return {
      available: true,
      provider: this.config.provider ?? 'openai-compatible',
      model,
      reason: `Inference provider ${this.config.provider ?? 'openai-compatible'} (${model}) is configured; answers are model-generated and grounded in retrieved passages.`,
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const status = this.status();
    if (!status.available || !this.config.baseUrl || !this.config.model) {
      throw new InferenceError(status.reason, 'knowledge');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref?.();
    const onAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      temperature: input.temperature,
      max_tokens: input.maxTokens,
      stream: true,
    };

    try {
      const response = await request(`${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        timeoutMs: this.config.timeoutMs,
        signal: input.signal,
        collect: false,
      });

      if (response.status < 200 || response.status >= 300) {
        // Drain the error body for a useful, bounded message.
        const errorBody = await readLimited(response.stream, 2000);
        throw new InferenceError(
          `Inference provider returned ${response.status}: ${errorBody.slice(0, 200)}`,
          'knowledge',
        );
      }
      const stream = response.stream;
      if (!stream) throw new InferenceError('Inference provider returned an empty stream.', 'knowledge');

      const decoder = new TextDecoder();
      let buffer = '';
      let full = '';

      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          buffer += decoder.decode(chunk, { stream: true });
          let newlineIndex = buffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            newlineIndex = buffer.indexOf('\n');
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? '';
              if (delta) {
                full += delta;
                input.onDelta?.(delta);
              }
            } catch {
              /* ignore keep-alive or malformed chunks */
            }
          }
        });
        stream.on('end', () => resolve());
        stream.on('error', (error) => reject(error));
        stream.on('aborted', () => reject(new Error('stream aborted')));
      });

      const text = full.trim();
      if (text.length === 0) throw new InferenceError('Inference provider produced no text.', 'knowledge');
      this.consecutiveFailures = 0;
      this.lastError = null;
      return { text, model: this.config.model, provider: this.config.provider ?? 'openai-compatible' };
    } catch (error) {
      if (error instanceof InferenceError) {
        this.consecutiveFailures += 1;
        this.lastError = error.message;
        this.logger.warn('inference failed; falling back to knowledge mode', { error });
        throw error;
      }
      this.consecutiveFailures += 1;
      const aborted =
        (error instanceof HttpError && (error.code === 'aborted' || error.code === 'timeout')) ||
        (error instanceof Error && error.name === 'AbortError') ||
        input.signal?.aborted === true;
      this.lastError = aborted ? 'request cancelled or timed out' : error instanceof Error ? error.message : 'unknown error';
      this.logger.warn('inference request errored; falling back to knowledge mode', { error });
      throw new InferenceError(`Inference request failed: ${this.lastError}`, 'knowledge');
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Shared prompt contract: grounded, citation-driven, refusal-friendly. */
  buildPrompt(input: {
    question: string;
    contextText: string;
    historyTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
    intent: string;
    sourcesList: string;
  }): { system: string; user: string } {
    const system = [
      'You are IDOL AI, an assistant that answers ONLY from the retrieved repository passages provided to you.',
      'Rules:',
      '1. Every factual sentence must end with one or more citation markers like [1] or [2] that refer to the numbered passages.',
      '2. Never cite a passage number that is not in the provided list. Never invent file paths, line numbers, flags, or values.',
      '3. If the passages do not contain the answer, say so plainly ("The indexed sources do not cover ...") instead of guessing.',
      '4. Quote exact commands, flags, and numbers from the passages; do not paraphrase numbers.',
      '5. Use Markdown: short paragraphs, bullet lists for options, fenced code blocks with a language tag for code or commands.',
      '6. Be concise (under 350 words). Answer the question first, then add supporting detail.',
      '7. Distinguish clearly between what a passage states and any general explanation you add; label the latter as explanation.',
      `The user's detected intent is "${input.intent}".`,
    ].join('\n');

    const history = input.historyTurns.length
      ? `Earlier conversation:\n${input.historyTurns
          .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.slice(0, 500)}`)
          .join('\n')}\n\n`
      : '';

    const user = `${history}Retrieved passages:\n\n${input.contextText}\n\nAvailable citations:\n${input.sourcesList}\n\nQuestion: ${input.question}\n\nAnswer using only the passages above, with [n] citations.`;
    return { system, user };
  }
}

/** Reads at most `limit` characters from an error response stream. */
function readLimited(stream: NodeJS.ReadableStream | null, limit: number): Promise<string> {
  if (!stream) return Promise.resolve('');
  return new Promise((resolve) => {
    let collected = '';
    stream.on('data', (chunk: Buffer) => {
      if (collected.length < limit) collected += chunk.toString('utf8');
    });
    stream.on('end', () => resolve(collected.slice(0, limit)));
    stream.on('error', () => resolve(collected.slice(0, limit)));
    setTimeout(() => resolve(collected.slice(0, limit)), 3000).unref?.();
  });
}
