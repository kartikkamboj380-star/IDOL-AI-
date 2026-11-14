/** Typed application errors mapped to HTTP status codes and client-safe messages. */
import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorBody } from '../../shared/types.js';
import type { Logger } from '../logger.js';

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found.') {
    super('not_found', message, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super('validation_error', message, 400);
  }
}

export class RateLimitError extends AppError {
  constructor(message: string, retryAfterSeconds: number) {
    super('rate_limited', message, 429, true);
    this.retryAfterSeconds = retryAfterSeconds;
  }
  retryAfterSeconds: number;
}

export class UpstreamError extends AppError {
  constructor(message: string, code = 'upstream_error', retryable = true) {
    super(code, message, 502, retryable);
  }
}

export class GitHubRateLimitedError extends AppError {
  constructor(
    message: string,
    readonly resetAt: Date | null,
    readonly remaining: number,
  ) {
    super('github_rate_limited', message, 429, true);
  }
}

export class GitHubUnauthorizedError extends AppError {
  constructor(message: string) {
    super('github_unauthorized', message, 401, false);
  }
}

export class MissingKnowledgeError extends AppError {
  constructor(message: string) {
    super('knowledge_unavailable', message, 409, false);
  }
}

export function toApiError(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, retryable: error.retryable } },
    };
  }
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  return { status: 500, body: { error: { code: 'internal_error', message, retryable: true } } };
}

export function errorHandler(logger: Logger) {
  return (error: unknown, req: Request, res: Response, next: NextFunction): void => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const { status, body } = toApiError(error);
    if (status >= 500) {
      logger.error('request failed', {
        method: req.method,
        path: req.path,
        code: body.error.code,
        error,
      });
    } else {
      logger.debug('request rejected', {
        method: req.method,
        path: req.path,
        code: body.error.code,
        message: body.error.message,
      });
    }
    if (error instanceof RateLimitError) res.setHeader('Retry-After', String(error.retryAfterSeconds));
    res.status(status).json(body);
  };
}

export function notFoundHandler(logger: Logger) {
  return (req: Request, res: Response): void => {
    logger.debug('no route for request', { method: req.method, path: req.path });
    const body: ApiErrorBody = {
      error: { code: 'not_found', message: `No API route matches ${req.method} ${req.path}.`, retryable: false },
    };
    res.status(404).json(body);
  };
}
