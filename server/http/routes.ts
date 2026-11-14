/**
 * REST + SSE surface for IDOL AI.
 *
 * Everything the browser needs is here; nothing secret is ever serialised.
 * Conversation history lives only in the browser's local storage — the server
 * is stateless between requests except for the knowledge index.
 */
import { Router, type Request, type Response } from 'express';
import type { AppStatus, ChatRequest, SearchResponse, SourceRef } from '../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { Retriever } from '../knowledge/retriever.js';
import type { AnswerPipeline } from '../engines/pipeline.js';
import type { InferenceAdapter } from '../inference/provider.js';
import type { GitHubClient } from '../knowledge/github-client.js';
import type { SecretStore } from '../store/secret-store.js';
import { RateLimiter } from '../util/rate-limit.js';
import { AppError, NotFoundError, RateLimitError, ValidationError } from '../util/errors.js';
import { openSse } from './sse.js';
import { readHistory, readString, readStringArray, requireJsonBody } from './security.js';
import { analyzeQuestion } from '../engines/question-analyzer.js';
import { detectIntent } from '../engines/intent.js';

export interface RouteDeps {
  config: AppConfig;
  logger: Logger;
  knowledge: KnowledgeService;
  retriever: Retriever;
  pipeline: AnswerPipeline;
  inference: InferenceAdapter;
  github: GitHubClient;
  secrets: SecretStore;
  startedAt: number;
}

export function createApiRouter(deps: RouteDeps): Router {
  const router = Router();
  const { config, knowledge, retriever, pipeline, inference, github, secrets, logger } = deps;
  const chatLimiter = new RateLimiter(config.rateLimitWindowMs, Math.max(8, Math.floor(config.rateLimitMaxRequests / 3)));
  const readLimiter = new RateLimiter(config.rateLimitWindowMs, config.rateLimitMaxRequests);

  const clientKey = (req: Request): string => {
    const forwarded = req.headers['x-forwarded-for'];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const ip = (value?.split(',')[0] ?? req.ip ?? 'unknown').trim();
    return ip.slice(0, 64) || 'unknown';
  };

  const guard = (limiter: RateLimiter) => (req: Request, res: Response): void => {
    const result = limiter.consume(clientKey(req));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));
    if (!result.allowed) {
      throw new RateLimitError(
        `Too many requests. Try again in ${result.retryAfterSeconds}s.`,
        result.retryAfterSeconds,
      );
    }
  };

  /* ------------------------------------------------------------------ */
  /* Status                                                              */
  /* ------------------------------------------------------------------ */

  router.get('/status', (_req, res) => {
    const status = inference.status();
    const secretInfo = secrets.describe();
    const payload: AppStatus = {
      ok: true,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000),
      inference: {
        available: status.available,
        mode: status.available ? 'inference' : 'knowledge',
        provider: status.provider,
        model: status.model,
        reason: status.reason,
      },
      knowledge: knowledge.stats(),
      github: {
        authenticated: github.authenticated,
        note: github.authenticated
          ? `GitHub access configured via ${secretInfo.source === 'env' ? 'server environment variable' : 'encrypted runtime token'}${secretInfo.login ? ` (${secretInfo.login})` : ''}.`
          : 'No GitHub token configured. Public repositories can still be indexed within the anonymous 60 requests/hour quota; add a token for higher limits and private repositories.',
      },
      limits: {
        maxMessageChars: config.maxMessageChars,
        maxFilesPerSource: config.maxFilesPerSource,
        maxFileBytes: config.maxFileBytes,
        maxContextChars: config.maxContextChars,
      },
    };
    res.json(payload);
  });

  router.get('/health', (_req, res) => {
    res.json({ ok: true, version: config.version, uptimeSeconds: Math.round((Date.now() - deps.startedAt) / 1000) });
  });

  /* ------------------------------------------------------------------ */
  /* Knowledge sources                                                   */
  /* ------------------------------------------------------------------ */

  router.get('/sources', (req, res) => {
    guard(readLimiter)(req, res);
    res.json({ sources: knowledge.listSources() });
  });

  router.post('/sources', async (req, res) => {
    guard(readLimiter)(req, res);
    const body = requireJsonBody(req);
    const kind = readString(body, 'kind', { required: true, maxLength: 20 }) as 'github' | 'local';
    if (kind === 'github') {
      let owner = readString(body, 'owner', { maxLength: 100 });
      let repo = readString(body, 'repo', { maxLength: 100 });
      const repository = readString(body, 'repository', { maxLength: 220 });
      if (repository) {
        const match = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repository.trim());
        if (!match?.[1] || !match[2]) throw new ValidationError('Enter a repository as "owner/repo" or a github.com URL.');
        owner = match[1];
        repo = match[2];
      }
      if (!owner || !repo) throw new ValidationError('Provide "repository" as "owner/repo" or separate owner/repo fields.');
      const ref = readString(body, 'ref', { maxLength: 120 });
      const source = await knowledge.addGitHubSource({ owner, repo, ref: ref ?? config.defaultRef, name: readString(body, 'name', { maxLength: 120 }) });
      res.status(201).json({ source });
      return;
    }
    if (kind === 'local') {
      if (!config.localDir) {
        throw new ValidationError(
          'Local directory indexing is disabled. Set IDOL_LOCAL_DIR to enable offline mode, or add a GitHub repository instead.',
        );
      }
      const source = await knowledge.addLocalSource(config.localDir, readString(body, 'name', { maxLength: 120 }));
      res.status(201).json({ source });
      return;
    }
    throw new ValidationError('Field "kind" must be "github" or "local".');
  });

  router.post('/sources/:id/reindex', async (req, res) => {
    guard(readLimiter)(req, res);
    const force = req.query.force === '1' || req.query.force === 'true';
    const source = await knowledge.reindex(req.params.id as string, { force });
    res.json({ source });
  });

  router.delete('/sources/:id', async (req, res) => {
    guard(readLimiter)(req, res);
    await knowledge.remove(req.params.id as string);
    res.json({ ok: true });
  });

  router.get('/sources/:id/tree', async (req, res) => {
    guard(readLimiter)(req, res);
    const path = typeof req.query.path === 'string' ? req.query.path : '';
    const result = await knowledge.listDirectory(req.params.id as string, path);
    res.json({
      sourceId: req.params.id,
      path,
      entries: result.entries,
      truncated: result.truncated,
    });
  });

  router.get('/sources/:id/file', async (req, res) => {
    guard(readLimiter)(req, res);
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) throw new ValidationError('Query parameter "path" is required.');
    if (filePath.length > 500) throw new ValidationError('Path is too long.');
    const file = await knowledge.readFile(req.params.id as string, filePath);
    const index = knowledge.getIndex(req.params.id as string);
    const citations = index?.passages.filter((passage) => passage.path === filePath).length ?? 0;
    res.json({
      sourceId: req.params.id,
      path: filePath,
      language: file.language,
      kind: file.kind,
      size: file.size,
      content: file.content,
      truncated: file.truncated,
      htmlUrl: file.htmlUrl,
      citations,
    });
  });

  /* ------------------------------------------------------------------ */
  /* Search                                                              */
  /* ------------------------------------------------------------------ */

  router.get('/search', (req, res) => {
    guard(readLimiter)(req, res);
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length < 2) throw new ValidationError('Query parameter "q" must be at least 2 characters.');
    if (query.length > 400) throw new ValidationError('Query is too long (max 400 characters).');
    const sourceIds = typeof req.query.sources === 'string' ? req.query.sources.split(',').map((id) => id.trim()).filter(Boolean) : undefined;
    const limit = Math.min(40, Math.max(1, Number.parseInt(String(req.query.limit ?? '12'), 10) || 12));
    const analysis = analyzeQuestion(query);
    const intent = detectIntent(analysis);
    const result = retriever.retrieve(query, {
      topK: limit,
      sourceIds,
      preferDocs: intent.intent !== 'code_explanation',
      preferCode: intent.intent === 'code_explanation' || intent.intent === 'bug_analysis',
    });
    const payload: SearchResponse = {
      query,
      normalizedQuery: analysis.normalized,
      totalPassages: retriever.corpusSize(),
      elapsedMs: result.elapsedMs,
      hits: result.hits.map((hit) => ({
        chunkId: hit.chunkId,
        sourceId: hit.sourceId,
        path: hit.path,
        heading: hit.heading,
        startLine: hit.startLine,
        endLine: hit.endLine,
        score: hit.score,
        signals: hit.signals,
        excerpt: hit.excerpt,
        kind: hit.kind,
        language: hit.language,
        htmlUrl: hit.htmlUrl,
      })),
    };
    res.json(payload);
  });

  /* ------------------------------------------------------------------ */
  /* Chat (SSE)                                                          */
  /* ------------------------------------------------------------------ */

  router.post('/chat', async (req, res) => {
    guard(chatLimiter)(req, res);
    const body = requireJsonBody(req);
    const message = readString(body, 'message', { required: true, maxLength: config.maxMessageChars, minLength: 1 });
    if (!message) throw new ValidationError('A message is required.');
    const conversationId = readString(body, 'conversationId', { maxLength: 80 }) ?? 'local';
    const history = readHistory(body, config.maxHistoryTurns, 1200);
    const sourceIds = readStringArray(body, 'sourceIds', 20);

    const request: ChatRequest = {
      conversationId,
      message,
      history,
      regenerate: body.regenerate === true,
      sourceIds,
    };
    logger.info('chat request', {
      conversationId,
      chars: message.length,
      historyTurns: history.length,
      intentPreview: detectIntent(analyzeQuestion(message)).intent,
      regenerate: request.regenerate === true,
    });

    const sse = openSse(res);
    const controller = new AbortController();
    req.on('close', () => {
      if (!sse.closed) controller.abort();
    });

    try {
      await pipeline.run({
        question: message,
        conversationId,
        history,
        sourceIds,
        emit: (event) => sse.send(event),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        logger.info('chat generation stopped by client', { conversationId });
      } else {
        logger.error('chat pipeline failed', { conversationId, error });
        sse.send({
          type: 'error',
          code: error instanceof AppError ? error.code : 'pipeline_error',
          message:
            error instanceof AppError
              ? error.message
              : 'Something went wrong while answering. Your message is safe — try again.',
          retryable: true,
        });
      }
    } finally {
      sse.close();
    }
  });

  /* ------------------------------------------------------------------ */
  /* GitHub connection management (server-side token, never returned)    */
  /* ------------------------------------------------------------------ */

  router.get('/github', async (req, res) => {
    guard(readLimiter)(req, res);
    const info = secrets.describe();
    const rate = await github.fetchRateLimit();
    res.json({
      authenticated: github.authenticated,
      tokenSource: info.source,
      login: info.login,
      scopes: info.scopes,
      envManaged: secrets.hasEnvToken,
      rateLimit: rate
        ? { limit: rate.limit, remaining: rate.remaining, reset: rate.reset?.toISOString() ?? null }
        : null,
    });
  });

  router.post('/github/token', async (req, res) => {
    guard(readLimiter)(req, res);
    const body = requireJsonBody(req);
    const token = readString(body, 'token', { required: true, maxLength: 500, minLength: 20 });
    if (!token) throw new ValidationError('A token is required.');
    if (secrets.hasEnvToken) {
      throw new ValidationError('A GITHUB_TOKEN environment variable is already configured; unset it to manage the token here.');
    }
    const identity = await github.verifyToken(token);
    secrets.save(token, { login: identity.login, scopes: identity.scopes ?? undefined });
    logger.info('GitHub token configured at runtime', { login: identity.login });
    res.json({ ok: true, login: identity.login, scopes: identity.scopes });
  });

  router.delete('/github/token', (req, res) => {
    guard(readLimiter)(req, res);
    if (secrets.hasEnvToken) {
      throw new ValidationError('The token comes from a server environment variable; remove GITHUB_TOKEN and restart to disconnect.');
    }
    const removed = secrets.clear();
    res.json({ ok: true, removed });
  });

  /* ------------------------------------------------------------------ */
  /* Suggestions (empty state)                                           */
  /* ------------------------------------------------------------------ */

  router.get('/suggestions', (req, res) => {
    guard(readLimiter)(req, res);
    const sources = knowledge.listSources().filter((source) => source.status === 'ready');
    const readyCount = sources.length;
    const hasDocs = sources.some((source) => source.filesIndexed && source.filesIndexed > 0);
    const suggestions: string[] = [];
    if (readyCount === 0) {
      suggestions.push(
        'What can you do?',
        'How do I add a repository to search?',
        'What happens if no knowledge source is indexed?',
      );
    } else if (!hasDocs) {
      suggestions.push('What is in the index?', 'What can you do?');
    } else {
      suggestions.push(
        'What is this repository about?',
        'How do I install and run it?',
        'Summarise the README',
        'What are the hardware requirements?',
        'Show me the benchmark results',
        'Which files define the main components?',
      );
    }
    res.json({ suggestions, sources: sources.length });
  });

  return router;
}

/** Small helper used by the app for citation deep links. */
export function buildCitation(source: SourceRef): string {
  return `${source.path}#L${source.startLine}-L${source.endLine}`;
}

export { NotFoundError };
