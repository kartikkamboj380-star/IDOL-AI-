/**
 * GitHub REST client used for knowledge ingestion.
 *
 * Responsibilities:
 *  - authenticated or anonymous requests with sane headers
 *  - Link-header pagination (contents listings, generic endpoints)
 *  - primary + secondary rate-limit handling with reset information
 *  - ETag based conditional requests for trees (cheap re-index checks)
 *  - explicit error mapping (no token leakage into messages)
 */
import {
  GitHubRateLimitedError,
  GitHubUnauthorizedError,
  NotFoundError,
  UpstreamError,
} from '../util/errors.js';
import { withRetry } from '../util/common.js';
import { HttpError, parseNextLink, request } from '../util/http.js';
import type { Logger } from '../logger.js';

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date | null;
  used?: number;
  resource?: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
  sha: string;
}

export interface RepoTree {
  entries: TreeEntry[];
  truncated: boolean;
  etag: string | null;
  sha: string;
}

interface GitHubRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  etag?: string | null;
  timeoutMs?: number;
  useAuth?: boolean;
  body?: string;
}

export interface GitHubResponse<T> {
  data: T | null;
  status: number;
  notModified: boolean;
  etag: string | null;
  rateLimit: RateLimitInfo | null;
  link: string | string[] | undefined;
}

const ACCEPT_JSON = 'application/vnd.github+json';
const ACCEPT_RAW = 'application/vnd.github.raw+json';

export class GitHubClient {
  readonly tokenProvider: () => string | null;
  private lastRateLimit: RateLimitInfo | null = null;

  constructor(
    private readonly apiBase: string,
    tokenProvider: () => string | null,
    private readonly logger: Logger,
    private readonly defaultTimeoutMs = 20_000,
  ) {
    this.tokenProvider = tokenProvider;
  }

  get authenticated(): boolean {
    return Boolean(this.tokenProvider());
  }

  get rateLimit(): RateLimitInfo | null {
    return this.lastRateLimit;
  }

  private endpoint(pathname: string): string {
    const base = this.apiBase.replace(/\/+$/, '');
    return `${base}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }

  private buildHeaders(options: GitHubRequestOptions): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: options.headers?.Accept ?? ACCEPT_JSON,
      'User-Agent': 'idol-ai-knowledge/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const token = options.useAuth === false ? null : this.tokenProvider();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.etag) headers['If-None-Match'] = options.etag;
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value;
    return headers;
  }

  private readRateLimit(headers: Record<string, string | string[] | undefined>): RateLimitInfo | null {
    const read = (name: string): string | undefined => {
      const value = headers[name] ?? headers[name.toLowerCase()];
      return Array.isArray(value) ? value[0] : value;
    };
    const limit = read('x-ratelimit-limit');
    const remaining = read('x-ratelimit-remaining');
    if (!limit || !remaining) return null;
    const reset = read('x-ratelimit-reset');
    const used = read('x-ratelimit-used');
    const resource = read('x-ratelimit-resource');
    const info: RateLimitInfo = {
      limit: Number(limit),
      remaining: Number(remaining),
      reset: reset ? new Date(Number(reset) * 1000) : null,
      used: used ? Number(used) : undefined,
      resource,
    };
    this.lastRateLimit = info;
    return info;
  }

  private handleRateLimit(status: number, headers: Record<string, string | string[] | undefined>, bodyText: string): void {
    if (status !== 403 && status !== 429) return;
    const rate = this.readRateLimit(headers);
    const remaining = rate?.remaining ?? 0;
    const retryAfterHeader = headers['retry-after'];
    const retryAfter = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
    const message = bodyText.toLowerCase();

    if (retryAfter || message.includes('secondary rate limit') || message.includes('abuse detection')) {
      const seconds = retryAfter ? Number(retryAfter) : 60;
      this.logger.warn('GitHub secondary rate limit hit', { retryAfterSeconds: seconds });
      throw new GitHubRateLimitedError(
        `GitHub asked us to slow down. Try again in ${Math.max(1, Math.ceil(seconds))}s.`,
        new Date(Date.now() + seconds * 1000),
        remaining,
      );
    }
    if (remaining === 0 || message.includes('rate limit exceeded') || message.includes('api rate limit')) {
      const reset = rate?.reset ?? null;
      const waitSeconds = reset ? Math.max(1, Math.ceil((reset.getTime() - Date.now()) / 1000)) : 60;
      this.logger.warn('GitHub primary rate limit exhausted', {
        limit: rate?.limit,
        resetAt: reset?.toISOString(),
        authenticated: this.authenticated,
      });
      const hint = this.authenticated
        ? 'The configured GitHub token has no remaining quota'
        : 'No GitHub token is configured, so the shared anonymous quota is used';
      throw new GitHubRateLimitedError(
        `GitHub API rate limit reached (${hint}). It resets in about ${Math.ceil(waitSeconds / 60)} minute(s).`,
        reset,
        remaining,
      );
    }
    throw new UpstreamError(
      'GitHub refused the request (403). The token may lack the required repository read permission.',
      'github_forbidden',
      false,
    );
  }

  async request<T>(pathname: string, options: GitHubRequestOptions = {}): Promise<GitHubResponse<T>> {
    const url = this.endpoint(pathname);
    const headers = this.buildHeaders(options);
    const isRaw = options.headers?.Accept === ACCEPT_RAW;
    const wantsStream = options.headers?.['X-Idol-Stream'] === '1';

    let response;
    try {
      response = await request(url, {
        method: options.method ?? 'GET',
        headers,
        body: options.body,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        collect: !wantsStream,
      });
    } catch (error) {
      const reason = error instanceof HttpError ? error.message : 'network error';
      throw new UpstreamError(`GitHub request failed: ${reason}`, 'github_unreachable', true);
    }

    const etagHeader = response.headers.etag;
    const etag = (Array.isArray(etagHeader) ? etagHeader[0] : etagHeader) ?? null;

    if (response.status === 304) {
      this.readRateLimit(response.headers);
      return { data: null, status: 304, notModified: true, etag, rateLimit: this.lastRateLimit, link: response.headers.link };
    }
    if (response.status === 404) {
      this.readRateLimit(response.headers);
      throw new NotFoundError(
        'GitHub could not find that repository, branch, or file. Check the name, and whether the token can read it.',
      );
    }
    if (response.status === 401) {
      throw new GitHubUnauthorizedError('GitHub rejected the configured token (401). Update or remove it in Sources → GitHub.');
    }
    if (response.status === 403 || response.status === 429) {
      this.handleRateLimit(response.status, response.headers, response.text);
    }

    const rateLimit = this.readRateLimit(response.headers);
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(
        `GitHub API error ${response.status}: ${response.text.slice(0, 200)}`,
        'github_error',
        response.status >= 500,
      );
    }

    if (isRaw) {
      return { data: response.text as unknown as T, status: response.status, notModified: false, etag, rateLimit, link: response.headers.link };
    }
    try {
      const parsed = JSON.parse(response.text) as T;
      return { data: parsed, status: response.status, notModified: false, etag, rateLimit, link: response.headers.link };
    } catch {
      throw new UpstreamError('GitHub returned a response that was not valid JSON.', 'github_bad_json', true);
    }
  }

  /**
   * Paginates a GitHub list endpoint. Uses per-page parameters and also honours
   * the Link header, so it works with both offset- and cursor-style endpoints.
   */
  async paginate<T>(pathname: string, maxItems = 10_000, perPage = 100): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    let nextUrl: string | null = null;
    for (;;) {
      const response = nextUrl
        ? await withRetry(
            () => this.requestAbsolute<T[]>(nextUrl as string),
            { attempts: 3, onRetry: (error, attempt) => this.logger.debug('retrying paginated request', { attempt, error }) },
          )
        : await withRetry(
            () => this.request<T[]>(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=${perPage}&page=${page}`),
            { attempts: 3, onRetry: (error, attempt) => this.logger.debug('retrying paginated request', { attempt, error }) },
          );
      const items = Array.isArray(response.data) ? response.data : [];
      results.push(...items);
      if (results.length >= maxItems) break;
      nextUrl = parseNextLink(response.link);
      if (!nextUrl && items.length < perPage) break;
      page += 1;
      if (page > 100) break;
    }
    return results.slice(0, maxItems);
  }

  private async requestAbsolute<T>(url: string): Promise<GitHubResponse<T>> {
    // Reuse the same header/ratelimit handling by proxying through request().
    const base = this.apiBase.replace(/\/+$/, '');
    if (!url.startsWith(base)) throw new UpstreamError('GitHub pagination returned an unexpected host.', 'github_bad_link', false);
    return this.request<T>(url.slice(base.length));
  }

  getRepo(owner: string, repo: string) {
    return this.request<{ default_branch: string; private: boolean; full_name: string; html_url: string }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
  }

  getBranch(owner: string, repo: string, branch: string) {
    return this.request<{ name: string; commit: { sha: string } }>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`,
    );
  }

  /** Recursive tree for a commit SHA or branch name (single request, may be truncated). */
  async getTree(owner: string, repo: string, ref: string, etag?: string | null): Promise<RepoTree> {
    const response = await withRetry(
      () =>
        this.request<{ tree: TreeEntry[]; truncated: boolean; sha: string }>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
          { etag: etag ?? null },
        ),
      { attempts: 3, onRetry: (error, attempt) => this.logger.debug('retrying tree request', { attempt, error }) },
    );
    if (response.notModified) {
      return { entries: [], truncated: false, etag: response.etag ?? etag ?? null, sha: ref };
    }
    const data = response.data;
    if (!data) throw new UpstreamError('GitHub returned an empty tree response.', 'github_empty_tree', true);
    return {
      entries: (data.tree ?? []).filter((entry) => entry.type === 'blob' || entry.type === 'tree'),
      truncated: Boolean(data.truncated),
      etag: response.etag ?? null,
      sha: data.sha,
    };
  }

  /** Raw file content at a ref (one request, no base64 decoding needed). */
  async getRawFile(owner: string, repo: string, path: string, ref: string): Promise<string> {
    const encodedPath = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const response = await withRetry(
      () =>
        this.request<string>(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
          { headers: { Accept: ACCEPT_RAW }, timeoutMs: 30_000 },
        ),
      { attempts: 3, onRetry: (error, attempt) => this.logger.debug('retrying raw file request', { attempt, error }) },
    );
    return typeof response.data === 'string' ? response.data : '';
  }

  /** Contents listing for one directory (used for repository browsing). */
  async listDirectory(owner: string, repo: string, path: string, ref: string) {
    const encodedPath = path
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const suffix = encodedPath ? `/contents/${encodedPath}` : '/contents';
    const response = await this.request<
      Array<{ name: string; path: string; type: 'file' | 'dir' | 'symlink' | 'submodule'; size: number }>
    >(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}?ref=${encodeURIComponent(ref)}`);
    return response.data ?? [];
  }

  /** Validates a token and returns non-secret identity metadata. */
  async verifyToken(token: string): Promise<{ login: string; scopes: string | null; name: string | null }> {
    let response;
    try {
      response = await request(this.endpoint('/user'), {
        headers: { Accept: ACCEPT_JSON, Authorization: `Bearer ${token}`, 'User-Agent': 'idol-ai-knowledge/1.0' },
        timeoutMs: 15_000,
      });
    } catch (error) {
      const reason = error instanceof HttpError ? error.message : 'network error';
      throw new UpstreamError(`Could not reach GitHub to verify the token: ${reason}`, 'github_unreachable', true);
    }
    if (response.status === 401) throw new GitHubUnauthorizedError('GitHub rejected that token.');
    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(`GitHub token verification failed (${response.status}).`);
    }
    const scopeHeader = response.headers['x-oauth-scopes'];
    const scopes = Array.isArray(scopeHeader) ? scopeHeader.join(', ') : (scopeHeader ?? null);
    try {
      const body = JSON.parse(response.text) as { login?: string; name?: string | null };
      return { login: body.login ?? 'unknown', scopes, name: body.name ?? null };
    } catch {
      throw new UpstreamError('GitHub returned an unexpected token-verification payload.');
    }
  }

  /** Rate-limit snapshot without consuming core quota. */
  async fetchRateLimit(): Promise<RateLimitInfo | null> {
    try {
      const response = await this.request<{ resources: Record<string, { limit: number; remaining: number; reset: number }> }>(
        '/rate_limit',
      );
      const core = response.data?.resources?.core;
      if (!core) return this.lastRateLimit;
      const info: RateLimitInfo = {
        limit: core.limit,
        remaining: core.remaining,
        reset: new Date(core.reset * 1000),
        resource: 'core',
      };
      this.lastRateLimit = info;
      return info;
    } catch {
      return this.lastRateLimit;
    }
  }
}
