/** Shared test helpers: an in-process server on an ephemeral port. */
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Trust the sandbox/proxy CA when present. Verification is never disabled: the
// bundle is *added* to the trust store. This must run before any outbound call,
// and it uses `fs` (not `require`) because this module is ESM.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  for (const candidate of [
    '/usr/local/share/ca-certificates/e2b-ca.crt',
    '/etc/ssl/certs/ca-certificates.crt',
  ]) {
    if (fs.existsSync(candidate)) {
      process.env.NODE_EXTRA_CA_CERTS = candidate;
      break;
    }
  }
}

import { loadConfig, type AppConfig } from '../server/config.js';
import { createLogger } from '../server/logger.js';
import { JsonStore } from '../server/store/json-store.js';
import { SecretStore } from '../server/store/secret-store.js';
import { GitHubClient } from '../server/knowledge/github-client.js';
import { KnowledgeService } from '../server/knowledge/service.js';
import { Retriever } from '../server/knowledge/retriever.js';
import { InferenceAdapter } from '../server/inference/provider.js';
import { AnswerPipeline } from '../server/engines/pipeline.js';
import { createApp } from '../server/app.js';
import { installExtraCaCerts } from '../server/util/tls.js';

export interface TestServer {
  baseUrl: string;
  config: AppConfig;
  knowledge: KnowledgeService;
  localSourceId: string;
  close: () => Promise<void>;
  dataDir: string;
}

export interface StartOptions {
  /** Local directory to index. Defaults to the repository itself. */
  localDir?: string;
  /** GitHub repo to index ("owner/repo"). Skipped when undefined. */
  githubRepo?: string;
  infereneConfig?: Partial<AppConfig['inference']>;
}

/** Starts a fully wired API server against a temporary data directory. */
export async function startTestServer(options: StartOptions = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'idol-test-'));
  const root = path.resolve(process.cwd());
  const config = loadConfig({
    dataDir,
    nodeEnv: 'test',
    defaultRepo: null,
    localDir: options.localDir ?? root,
    port: 0,
    inference: {
      provider: null,
      baseUrl: null,
      apiKey: null,
      model: null,
      maxTokens: 400,
      temperature: 0.2,
      timeoutMs: 5000,
      ...options.infereneConfig,
    } as AppConfig['inference'],
  });

  const logger = createLogger('test');
  installExtraCaCerts(logger);
  const store = new JsonStore(dataDir, logger);
  const secrets = new SecretStore(dataDir, process.env.GITHUB_TOKEN ?? null, logger);
  const github = new GitHubClient(config.githubApiBase, () => secrets.getToken(), logger);
  const knowledge = new KnowledgeService(config, logger, store, github);
  const retriever = new Retriever(() => knowledge.retrieverSources());
  const inference = new InferenceAdapter(
    {
      provider: null,
      baseUrl: null,
      apiKey: null,
      model: null,
      timeoutMs: 5000,
    },
    logger,
  );
  const pipeline = new AnswerPipeline(config, logger, knowledge, retriever, inference);
  const app = createApp({
    config,
    logger,
    knowledge,
    retriever,
    pipeline,
    inference,
    github,
    secrets,
    startedAt: Date.now(),
  });

  await knowledge.init();
  await knowledge.idle();

  const sources = knowledge.listSources();
  const localSource = sources.find((source) => source.kind === 'local');
  if (!localSource) throw new Error('Local source was not indexed during bootstrap.');

  const server: Server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    config,
    knowledge,
    localSourceId: localSource.id,
    dataDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await knowledge.idle();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Minimal SSE client for /api/chat that collects every event. */
export async function chat(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ events: Array<Record<string, unknown>>; answer: Record<string, unknown> | null; text: string }> {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`chat failed: ${response.status} ${await response.text()}`);
  }
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: Array<Record<string, unknown>> = [];
  let streamedText = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        events.push(event);
        if (event.type === 'delta') streamedText += String(event.text ?? '');
      }
    }
  }
  const done = events.find((event) => event.type === 'done');
  return {
    events,
    answer: (done?.answer as Record<string, unknown> | undefined) ?? null,
    text: streamedText,
  };
}

export async function json<T>(baseUrl: string, path: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export async function post<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

export async function statusOf(baseUrl: string, path: string): Promise<number> {
  const response = await fetch(`${baseUrl}${path}`);
  await response.text();
  return response.status;
}
