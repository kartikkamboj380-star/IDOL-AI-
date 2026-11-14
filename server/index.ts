/**
 * IDOL AI server entry point.
 *
 * Boot order matters: configuration → stores → GitHub client → knowledge
 * (which may index on first run) → engines → HTTP. The server starts listening
 * before background bootstrap indexing finishes so the UI is responsive, and
 * the client polls /api/status while the index is built.
 */
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { JsonStore } from './store/json-store.js';
import { SecretStore } from './store/secret-store.js';
import { GitHubClient } from './knowledge/github-client.js';
import { KnowledgeService } from './knowledge/service.js';
import { Retriever } from './knowledge/retriever.js';
import { InferenceAdapter } from './inference/provider.js';
import { AnswerPipeline } from './engines/pipeline.js';
import { createApp } from './app.js';
import { installExtraCaCerts } from './util/tls.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.nodeEnv);
  const startedAt = Date.now();
  installExtraCaCerts(logger);

  logger.info('starting IDOL AI', {
    version: config.version,
    env: config.nodeEnv,
    port: config.port,
    dataDir: config.dataDir,
  });

  const store = new JsonStore(config.dataDir, logger.child('store'));
  const secrets = new SecretStore(config.dataDir, config.githubToken, logger.child('secrets'));
  const github = new GitHubClient(config.githubApiBase, () => secrets.getToken(), logger.child('github'));
  const knowledge = new KnowledgeService(config, logger.child('knowledge'), store, github);
  const retriever = new Retriever(() => knowledge.retrieverSources());
  const inference = new InferenceAdapter(
    {
      provider: config.inference.provider,
      baseUrl: config.inference.baseUrl,
      apiKey: config.inference.apiKey,
      model: config.inference.model,
      timeoutMs: config.inference.timeoutMs,
    },
    logger.child('inference'),
  );
  const pipeline = new AnswerPipeline(config, logger.child('pipeline'), knowledge, retriever, inference);

  const app = createApp({
    config,
    logger,
    knowledge,
    retriever,
    pipeline,
    inference,
    github,
    secrets,
    startedAt,
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('listening', { url: `http://${config.host}:${config.port}` });
    const status = inference.status();
    logger.info(status.available ? 'inference mode enabled' : 'knowledge mode (no inference provider configured)');
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      logger.error(`port ${config.port} is already in use. Set PORT to a free port.`);
    } else {
      logger.error('server error', { error });
    }
    process.exitCode = 1;
  });

  // Boot the knowledge index in the background so the first paint is instant.
  void (async () => {
    try {
      await knowledge.init();
      logger.info('knowledge ready', { ...knowledge.stats() });
    } catch (error) {
      logger.error('knowledge initialisation failed; the app will run with an empty index', { error });
    }
  })();

  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    server.close(() => {
      void knowledge.idle().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { error: reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', { error });
    process.exitCode = 1;
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('fatal startup error', error);
  process.exit(1);
});
