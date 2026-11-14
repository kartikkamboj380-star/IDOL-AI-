#!/usr/bin/env node
/**
 * One-shot self-index: builds the knowledge index from this checkout and prints
 * what was actually indexed, so you can confirm retrieval works before opening
 * the UI. Exits non-zero if nothing was indexed.
 *
 *   npm run index:self
 */
import { loadConfig } from '../server/config.js';
import { createLogger } from '../server/logger.js';
import { JsonStore } from '../server/store/json-store.js';
import { SecretStore } from '../server/store/secret-store.js';
import { GitHubClient } from '../server/knowledge/github-client.js';
import { KnowledgeService } from '../server/knowledge/service.js';
import { Retriever } from '../server/knowledge/retriever.js';
import { installExtraCaCerts } from '../server/util/tls.js';

const logger = createLogger('index');
const config = loadConfig({ nodeEnv: process.env.NODE_ENV ?? 'development' });
installExtraCaCerts(logger);

const store = new JsonStore(config.dataDir, logger);
const secrets = new SecretStore(config.dataDir, process.env.GITHUB_TOKEN ?? null, logger);
const github = new GitHubClient(config.githubApiBase, () => secrets.getToken(), logger);
const knowledge = new KnowledgeService(config, logger, store, github);
const retriever = new Retriever(() => knowledge.retrieverSources());

console.log(
  [
    `IDOL AI ${process.env.npm_package_version ?? '1.0.0'} — self-index`,
    `  local dir:    ${config.localDir ?? '(disabled)'}`,
    `  default repo: ${config.defaultRepo ?? '(none)'}`,
    `  data dir:     ${config.dataDir}`,
    `  inference:    ${config.inference.provider ?? 'not configured (knowledge mode)'}`,
  ].join('\n'),
);

await knowledge.init();
await knowledge.idle();

const sources = knowledge.listSources();
if (sources.length === 0) {
  console.error('No knowledge sources found. Set IDOL_LOCAL_DIR or IDOL_DEFAULT_REPO.');
  process.exitCode = 1;
} else {
  for (const source of sources) {
    console.log(
      `\n[${source.kind}] ${source.name} — ${source.status}\n` +
        `  id:        ${source.id}\n` +
        `  files:     ${source.filesIndexed}\n` +
        `  passages:  ${source.passages}\n` +
        `  bytes:     ${source.bytesIndexed}\n` +
        `  ref:       ${source.resolvedRef ?? 'n/a'}\n` +
        `  indexed:   ${source.lastIndexedAt ?? 'never'}` +
        (source.lastError ? `\n  error:     ${source.lastError}` : ''),
    );
  }

  // A quick retrieval sanity check against the live index.
  const probe = process.argv[2] ?? 'what is this project about';
  const result = retriever.retrieve(probe, { topK: 3, preferDocs: true });
  console.log(`\nRetrieval probe: "${probe}"`);
  if (result.hits.length === 0) {
    console.log('  (no passages matched)');
  } else {
    for (const hit of result.hits) {
      console.log(`  ${hit.score.toFixed(2)}  ${hit.path}:${hit.startLine}-${hit.endLine}  ${hit.heading ?? ''}`);
    }
  }
  console.log(`\nCorpus: ${retriever.corpusSize()} passages across ${sources.length} source(s).`);
  console.log(`Data directory: ${config.dataDir}`);
}
