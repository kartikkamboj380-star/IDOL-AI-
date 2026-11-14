/** Security headers, body validation helpers, and input sanitisation. */
import type { NextFunction, Request, Response } from 'express';
import { PayloadTooLargeError, ValidationError } from '../util/errors.js';

/**
 * Strict CSP for the SPA. The UI ships no third-party scripts; code
 * highlighting and markdown rendering happen locally from bundled modules.
 */
export function securityHeaders(isDev: boolean) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    const csp = [
      "default-src 'self'",
      // Vite dev mode injects inline scripts for HMR; production uses files only.
      `script-src 'self'${isDev ? " 'unsafe-inline' 'unsafe-eval'" : ''}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://github.com https://avatars.githubusercontent.com",
      "font-src 'self' data:",
      "connect-src 'self'" + (isDev ? ' ws: wss:' : ''),
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    res.setHeader('Content-Security-Policy', csp);
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  };
}

export function requireJsonBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Expected a JSON object body.');
  }
  return body as Record<string, unknown>;
}

export function readString(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number; minLength?: number; trim?: boolean } = {},
): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) {
    if (options.required) throw new ValidationError(`Field "${key}" is required.`);
    return undefined;
  }
  if (typeof raw !== 'string') throw new ValidationError(`Field "${key}" must be a string.`);
  const value = options.trim === false ? raw : raw.trim();
  if (options.required && value.length === 0) throw new ValidationError(`Field "${key}" must not be empty.`);
  if (options.minLength !== undefined && value.length > 0 && value.length < options.minLength) {
    throw new ValidationError(`Field "${key}" must be at least ${options.minLength} characters.`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new PayloadTooLargeError(
      `Field "${key}" is ${value.length} characters, over the ${options.maxLength}-character limit.`,
    );
  }
  return value;
}

export function readStringArray(body: Record<string, unknown>, key: string, maxItems = 20): string[] | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ValidationError(`Field "${key}" must be an array of strings.`);
  const values = raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
  if (values.length > maxItems) throw new ValidationError(`Field "${key}" may contain at most ${maxItems} items.`);
  return values;
}

export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export function readHistory(body: Record<string, unknown>, maxTurns: number, maxChars: number): HistoryTurn[] {
  const raw = body.history;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ValidationError('Field "history" must be an array.');
  const turns: HistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string' || content.trim().length === 0) continue;
    turns.push({ role, content: content.slice(0, maxChars) });
  }
  // Context-window management: keep the most recent turns and cap total chars.
  const recent = turns.slice(-maxTurns);
  const budget = maxChars * 4;
  let used = 0;
  const kept: HistoryTurn[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const turn = recent[i] as HistoryTurn;
    if (used + turn.content.length > budget) break;
    used += turn.content.length;
    kept.unshift(turn);
  }
  return kept;
}

/** Detects whether the request is HTTPS or behind a trusted proxy. */
export function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  const value = Array.isArray(proto) ? proto[0] : proto;
  return value === 'https';
}
