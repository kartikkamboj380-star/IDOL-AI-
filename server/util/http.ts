/**
 * Outbound HTTP helper built on Node's `https` module.
 *
 * Why not global fetch? `fetch` (undici) uses its own TLS stack and ignores
 * `https.globalAgent`, so a deployment that trusts a private CA via
 * NODE_EXTRA_CA_CERTS would still fail. Using `https.request` means the extra
 * CA bundle applies consistently, streaming works, and we control timeouts.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  /** Raw stream for SSE proxying; null when `collect` was true. */
  stream: http.IncomingMessage | null;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** When false, the response stream is returned un-consumed (for SSE). */
  collect?: boolean;
}

export class HttpError extends Error {
  constructor(message: string, override readonly cause: unknown, readonly code: string) {
    super(message);
    this.name = 'HttpError';
  }
}

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

export function request(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return new Promise<HttpResponse>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new HttpError(`Invalid URL: ${url}`, null, 'invalid_url'));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const collect = options.collect !== false;

    const requestOptions: https.RequestOptions = {
      method: options.method ?? 'GET',
      headers: options.headers,
      // Keep TLS verification on; an extra trusted CA may be supplied globally.
      rejectUnauthorized: true,
    };

    if (isHttps) requestOptions.agent = https.globalAgent;

    const req = transport.request(parsed, requestOptions, (res) => {
      if (!collect) {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: '',
          stream: res,
        });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new HttpError('Response exceeded the size limit.', null, 'response_too_large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
          stream: null,
        });
      });
      res.on('error', (error) => reject(new HttpError('Response stream failed.', error, 'stream_error')));
    });

    req.on('error', (error) => reject(new HttpError(describeNetworkError(error), error, 'network_error')));

    const timeout = options.timeoutMs ?? 20_000;
    req.setTimeout(timeout, () => {
      req.destroy(new HttpError(`Request timed out after ${timeout}ms.`, null, 'timeout'));
    });

    if (options.signal) {
      if (options.signal.aborted) {
        req.destroy(new HttpError('Request aborted.', null, 'aborted'));
        return;
      }
      const onAbort = (): void => {
        req.destroy(new HttpError('Request aborted.', null, 'aborted'));
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => options.signal?.removeEventListener('abort', onAbort));
    }

    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Turns low-level TLS/DNS errors into actionable messages (no secrets). */
function describeNetworkError(error: unknown): string {
  const err = error as NodeJS.ErrnoException & { code?: string };
  if (!err) return 'Network request failed.';
  switch (err.code) {
    case 'ENOTFOUND':
      return 'DNS lookup failed — the host could not be resolved.';
    case 'ECONNREFUSED':
      return 'Connection refused by the remote host.';
    case 'ETIMEDOUT':
      return 'Connection timed out.';
    case 'ENETUNREACH':
      return 'Network unreachable.';
    case 'CERT_HAS_EXPIRED':
      return 'TLS certificate has expired.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return `TLS certificate could not be verified (${err.code}). If your environment uses a private CA, set NODE_EXTRA_CA_CERTS to its PEM bundle.`;
    default:
      return err.message || 'Network request failed.';
  }
}

/** Parses a GitHub Link header into a next-page URL, if present. */
export function parseNextLink(linkHeader: string | string[] | undefined): string | null {
  const value = Array.isArray(linkHeader) ? linkHeader.join(',') : linkHeader;
  if (!value) return null;
  for (const part of value.split(',')) {
    if (!/rel="next"/.test(part)) continue;
    const match = /<([^>]+)>/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}
