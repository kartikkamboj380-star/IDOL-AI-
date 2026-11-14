/**
 * Express application: JSON API under /api, the built SPA everywhere else.
 * A single origin keeps CSP tight and lets the browser use relative URLs only.
 */
import express, { type Express } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import type { KnowledgeService } from './knowledge/service.js';
import type { Retriever } from './knowledge/retriever.js';
import type { AnswerPipeline } from './engines/pipeline.js';
import type { InferenceAdapter } from './inference/provider.js';
import type { GitHubClient } from './knowledge/github-client.js';
import type { SecretStore } from './store/secret-store.js';
import { createApiRouter } from './http/routes.js';
import { errorHandler, notFoundHandler } from './util/errors.js';
import { securityHeaders } from './http/security.js';

export interface AppDeps {
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

export function createApp(deps: AppDeps): Express {
  const app = express();
  const { config, logger } = deps;
  const isDev = config.nodeEnv !== 'production';

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(securityHeaders(isDev));
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));

  app.use('/api', createApiRouter(deps));
  app.use('/api', notFoundHandler(logger));

  // Static assets: hashed filenames are immutable, index.html must not be cached.
  const distDir = config.webDistDir;
  const indexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    app.use(
      express.static(distDir, {
        index: false,
        setHeaders: (res, filePath) => {
          if (/\/assets\//.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  } else {
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res
        .status(503)
        .type('text/plain')
        .send(
          [
            'IDOL AI API is running, but the web client has not been built yet.',
            '',
            'Run `npm run build` and restart, or use `npm run dev` for the development server.',
            'The JSON API is available under /api (try /api/status).',
          ].join('\n'),
        );
    });
  }

  app.use(errorHandler(logger));
  return app;
}
