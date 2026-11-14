/**
 * KnowledgeService — owns knowledge sources, their indexes, and re-indexing.
 *
 * Sources are either:
 *   - `github`: a repository tree fetched through the GitHub REST API
 *   - `local` : a directory on the server filesystem (offline/self-hosted mode)
 *
 * Indexing is incremental: a content hash per file lets a re-index reuse the
 * passages of unchanged files and only fetch what actually changed. GitHub
 * tree requests use ETags so an unchanged branch costs a single 304 response.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ChunkKind,
  KnowledgeSource,
  SourceStatsSummary,
  SourceStatus,
} from '../../shared/types.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { JsonStore } from '../store/json-store.js';
import { GitHubClient, type TreeEntry } from './github-client.js';
import { AppError, NotFoundError, UpstreamError, ValidationError } from '../util/errors.js';
import { mapLimit, newId, sha256, truncate } from '../util/common.js';
import {
  MAX_TEXT_BYTES,
  basename,
  fileFamily,
  parseFile,
  type ParsedFile,
} from './file-types.js';
import {
  buildInvertedIndex,
  buildPassages,
  type Passage,
  type SourceIndex,
  type SourceIndexFile,
} from './indexer.js';

interface StoredSource extends KnowledgeSource {
  etag?: string | null;
  treeSha?: string;
  /** Relative paths of files that were skipped, with reasons (capped). */
  skipped?: Array<{ path: string; reason: string }>;
}

interface SourcesFile {
  version: number;
  sources: StoredSource[];
}

const SOURCES_FILE = 'sources.json';
const INDEX_VERSION = 2;
const MAX_SKIPPED_RECORDS = 120;

/** Files are ranked by how likely they are to answer documentation questions. */
function filePriority(filePath: string, size: number): number {
  const lower = filePath.toLowerCase();
  const name = basename(lower);
  let score = 50;
  if (name.startsWith('readme')) score += 220;
  else if (lower.startsWith('docs/') || lower.includes('/docs/')) score += 160;
  else if (name.endsWith('.md') || name.endsWith('.mdx')) score += 120;
  else if (name === 'package.json' || name === 'config.json' || name.endsWith('.toml')) score += 60;
  else if (lower.includes('contributing') || lower.includes('architecture') || lower.includes('guide')) score += 90;
  else if (name === 'license') score += 10;
  else if (fileFamily(filePath) === 'code') score += 45;
  else score += 20;
  // Prefer top-level documentation; deep vendored paths lose.
  const depth = filePath.split('/').length - 1;
  score -= depth * 6;
  if (lower.startsWith('test/') || lower.startsWith('tests/') || lower.includes('/__tests__/')) score -= 25;
  if (lower.startsWith('scripts/')) score -= 5;
  // Tiny files rarely carry knowledge; huge files are expensive.
  if (size < 120) score -= 15;
  if (size > MAX_TEXT_BYTES) score -= 1000;
  return score;
}

function toPublicSource(source: StoredSource): KnowledgeSource {
  const { etag, treeSha, skipped, ...rest } = source;
  void etag;
  void treeSha;
  void skipped;
  return rest;
}

export interface AddGitHubInput {
  owner: string;
  repo: string;
  ref?: string | null;
  /** Optional display override. */
  name?: string;
}

export class KnowledgeService {
  private sources = new Map<string, StoredSource>();
  private readonly includeAppSources: boolean;
  private indexes = new Map<string, SourceIndex>();
  private activeJobs = new Map<string, Promise<KnowledgeSource>>();
  private loaded = false;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
    private readonly store: JsonStore,
    private readonly github: GitHubClient,
  ) {
    this.includeAppSources = config.nodeEnv === 'test' || process.env.IDOL_INDEX_APP_SOURCES === '1';
  }

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const file = this.store.read<SourcesFile>(SOURCES_FILE, { version: 1, sources: [] });
    for (const source of file.sources ?? []) {
      if (!source?.id) continue;
      const index = this.store.read<SourceIndex | null>(`index-${source.id}.json`, null);
      if (index && index.sourceId === source.id) {
        this.indexes.set(source.id, index);
        if (source.status === 'indexing') source.status = 'ready';
      } else if (source.status === 'ready') {
        source.status = 'stale';
        source.lastError = 'The stored index was missing, so this source must be re-indexed.';
      }
      this.sources.set(source.id, source);
    }
    this.logger.info('loaded knowledge sources', { count: this.sources.size });

    if (this.sources.size === 0) {
      await this.bootstrap();
    } else {
      this.refreshLocalSources();
    }
  }

  /** First-run convenience: index the current checkout so chat works instantly. */
  private async bootstrap(): Promise<void> {
    const localRoot = this.config.localDir ?? process.cwd();
    const looksLikeRepo = await this.directoryHasRepoMarker(localRoot);
    if (looksLikeRepo) {
      try {
        const source = await this.addLocalSource(localRoot, 'This repository (local checkout)');
        this.logger.info('bootstrapped local knowledge source', { id: source.id, files: source.filesIndexed });
      } catch (error) {
        this.logger.warn('could not bootstrap local knowledge source', { error });
      }
    }
    const repo = this.config.defaultRepo;
    if (repo && this.github.authenticated) {
      const [owner, name] = repo.split('/');
      if (owner && name) {
        try {
          await this.addGitHubSource({ owner, repo: name, ref: this.config.defaultRef });
          this.logger.info('bootstrapped GitHub knowledge source', { repo });
        } catch (error) {
          this.logger.warn('could not bootstrap GitHub knowledge source', { repo, error });
        }
      }
    }
    this.persistSources();
  }

  private async directoryHasRepoMarker(dir: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dir);
      return entries.includes('.git') || entries.includes('README.md') || entries.includes('package.json');
    } catch {
      return false;
    }
  }

  /** Marks local sources stale when their directory changed while offline. */
  private refreshLocalSources(): void {
    for (const source of this.sources.values()) {
      if (source.kind !== 'local') continue;
      if (!source.localPath) continue;
      void fs
        .stat(source.localPath)
        .then((stat) => {
          if (!stat.isDirectory()) {
            source.status = 'error';
            source.lastError = 'The local knowledge directory no longer exists.';
          }
        })
        .catch(() => {
          source.status = 'error';
          source.lastError = 'The local knowledge directory is not readable.';
        });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Queries                                                             */
  /* ------------------------------------------------------------------ */

  listSources(): KnowledgeSource[] {
    return [...this.sources.values()]
      .map(toPublicSource)
      .sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  getSource(id: string): KnowledgeSource {
    const source = this.sources.get(id);
    if (!source) throw new NotFoundError('That knowledge source does not exist.');
    return toPublicSource(source);
  }

  getIndex(id: string): SourceIndex | null {
    return this.indexes.get(id) ?? null;
  }

  /** Shape consumed by the Retriever. */
  retrieverSources(): Array<{
    index: SourceIndex;
    sourceName: string;
    htmlUrlFor: (filePath: string) => string | null;
  }> {
    const out: Array<{ index: SourceIndex; sourceName: string; htmlUrlFor: (p: string) => string | null }> = [];
    for (const [id, index] of this.indexes) {
      const source = this.sources.get(id);
      if (!source || source.status === 'error') continue;
      out.push({
        index,
        sourceName: source.name,
        htmlUrlFor: (filePath: string) => this.htmlUrlFor(source, index, filePath),
      });
    }
    return out;
  }

  private htmlUrlFor(source: StoredSource, index: SourceIndex, filePath: string): string | null {
    if (source.kind === 'github' && source.owner && source.repo) {
      return `https://github.com/${source.owner}/${source.repo}/blob/${index.resolvedRef}/${filePath}`;
    }
    return source.htmlUrl ?? null;
  }

  stats(): SourceStatsSummary {
    let files = 0;
    let passages = 0;
    let bytes = 0;
    let ready = 0;
    let last: string | null = null;
    for (const source of this.sources.values()) {
      files += source.filesIndexed ?? 0;
      passages += source.passages ?? 0;
      bytes += source.bytesIndexed ?? 0;
      if (source.status === 'ready') ready += 1;
      if (source.lastIndexedAt && (!last || source.lastIndexedAt > last)) last = source.lastIndexedAt;
    }
    return {
      totalSources: this.sources.size,
      readySources: ready,
      totalFiles: files,
      totalPassages: passages,
      totalBytes: bytes,
      lastIndexedAt: last,
    };
  }

  totalPassages(): number {
    let total = 0;
    for (const index of this.indexes.values()) total += index.passages.length;
    return total;
  }

  findFile(sourceId: string, filePath: string): SourceIndexFile | null {
    const index = this.indexes.get(sourceId);
    if (!index) return null;
    return index.files.find((file) => file.path === filePath) ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Mutations                                                           */
  /* ------------------------------------------------------------------ */

  async addGitHubSource(input: AddGitHubInput): Promise<KnowledgeSource> {
    const owner = input.owner?.trim();
    const repo = input.repo?.trim();
    if (!owner || !repo) throw new ValidationError('Owner and repository name are required.');
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
      throw new ValidationError('Owner and repository may only contain letters, numbers, dots, dashes, and underscores.');
    }
    const ref = input.ref?.trim() || null;
    const existing = [...this.sources.values()].find(
      (source) => source.kind === 'github' && source.owner === owner && source.repo === repo && (source.ref ?? '') === (ref ?? ''),
    );
    if (existing) return this.reindex(existing.id);

    const source: StoredSource = {
      id: newId('src'),
      kind: 'github',
      name: input.name?.trim() || `${owner}/${repo}`,
      owner,
      repo,
      ref: ref ?? undefined,
      status: 'indexing',
      addedAt: new Date().toISOString(),
      htmlUrl: `https://github.com/${owner}/${repo}`,
    };
    this.sources.set(source.id, source);
    this.persistSources();
    return this.runIndex(source);
  }

  async addLocalSource(dirPath: string, name?: string): Promise<KnowledgeSource> {
    const resolved = path.resolve(dirPath);
    const stat = await fs.stat(resolved).catch(() => null);
    if (!stat || !stat.isDirectory()) throw new ValidationError('That local directory does not exist.');
    const existing = [...this.sources.values()].find((source) => source.kind === 'local' && source.localPath === resolved);
    if (existing) return this.reindex(existing.id);
    const source: StoredSource = {
      id: newId('src'),
      kind: 'local',
      name: name?.trim() || `${basename(resolved)} (local)`,
      localPath: resolved,
      status: 'indexing',
      addedAt: new Date().toISOString(),
    };
    this.sources.set(source.id, source);
    this.persistSources();
    return this.runIndex(source);
  }

  async reindex(id: string, options: { force?: boolean } = {}): Promise<KnowledgeSource> {
    const source = this.sources.get(id);
    if (!source) throw new NotFoundError('That knowledge source does not exist.');
    if (this.activeJobs.has(id)) return this.activeJobs.get(id) as Promise<KnowledgeSource>;
    const job = this.runIndex(source, options.force ?? false);
    this.activeJobs.set(id, job);
    return job;
  }

  async remove(id: string): Promise<void> {
    const source = this.sources.get(id);
    if (!source) throw new NotFoundError('That knowledge source does not exist.');
    this.sources.delete(id);
    this.indexes.delete(id);
    this.store.remove(`index-${id}.json`);
    this.persistSources();
    this.logger.info('removed knowledge source', { id, name: source.name });
  }

  /** Waits for all in-flight indexing jobs (used by tests and graceful shutdown). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.activeJobs.values()]);
  }

  private runIndex(source: StoredSource, force = false): Promise<KnowledgeSource> {
    const promise = (async () => {
      const started = Date.now();
      source.status = 'indexing';
      source.lastError = undefined;
      this.persistSources();
      try {
        const index =
          source.kind === 'github'
            ? await this.indexGitHub(source, force)
            : await this.indexLocal(source);
        this.indexes.set(source.id, index);
        this.store.write(`index-${source.id}.json`, index);
        source.status = 'ready';
        source.filesIndexed = index.stats.filesIndexed;
        source.passages = index.passages.length;
        source.bytesIndexed = index.stats.bytes;
        source.skippedFiles = index.stats.skipped;
        source.truncatedTree = index.stats.truncatedTree;
        source.lastIndexedAt = new Date().toISOString();
        source.resolvedRef = index.resolvedRef;
        source.lastError = undefined;
        this.logger.info('indexed source', {
          name: source.name,
          files: index.stats.filesIndexed,
          passages: index.passages.length,
          ms: Date.now() - started,
        });
      } catch (error) {
        const message = error instanceof AppError ? error.message : error instanceof Error ? error.message : 'Indexing failed.';
        source.status = error instanceof AppError && error.code === 'github_rate_limited' ? 'rate_limited' : 'error';
        source.lastError = message;
        this.logger.error('indexing failed', { name: source.name, error });
        throw error;
      } finally {
        this.activeJobs.delete(source.id);
        this.persistSources();
      }
      return toPublicSource(source);
    })();
    return promise;
  }

  /* ------------------------------------------------------------------ */
  /* GitHub indexing                                                     */
  /* ------------------------------------------------------------------ */

  private async indexGitHub(source: StoredSource, force: boolean): Promise<SourceIndex> {
    const owner = source.owner as string;
    const repo = source.repo as string;
    const repoInfo = await this.github.getRepo(owner, repo);
    if (!repoInfo.data) throw new UpstreamError('GitHub returned no repository metadata.');
    let ref = source.ref ?? repoInfo.data.default_branch;
    let resolvedRef = ref;
    const branch = await this.github.getBranch(owner, repo, ref).catch(() => null);
    if (branch?.data?.commit?.sha) {
      resolvedRef = branch.data.commit.sha;
    } else {
      // `ref` may already be a commit SHA (or a tag); GitHub resolves it server-side.
      resolvedRef = ref;
    }
    source.ref = ref;

    const tree = await this.github.getTree(owner, repo, resolvedRef, force ? null : source.etag);
    if (tree.entries.length === 0 && tree.etag === source.etag) {
      const existing = this.indexes.get(source.id);
      if (existing) {
        this.logger.info('GitHub tree unchanged (304); keeping existing index', { name: source.name });
        return existing;
      }
    }
    source.etag = tree.etag;

    const previous = this.indexes.get(source.id);
    const previousFiles = new Map<string, SourceIndexFile>(
      previous ? previous.files.map((file) => [file.path, file]) : [],
    );
    const previousPassages = previous ? new Map(previous.passages.map((passage) => [passage.id, passage])) : new Map();

    const candidates = this.selectGitHubFiles(tree.entries, tree.truncated);
    const previousByContent = new Map<string, SourceIndexFile>();
    for (const file of previousFiles.values()) {
      if (file.sha) previousByContent.set(`${file.path}:${file.sha}`, file);
    }

    const fetched: Array<{
      file: ParsedFile;
      sha: string | null;
      size: number;
      reusedPassages?: Passage[];
    }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let bytes = 0;

    const toFetch: TreeEntry[] = [];
    for (const entry of candidates) {
      const priorFile = previousFiles.get(entry.path);
      if (!force && priorFile && priorFile.sha === entry.sha) {
        const passages = priorFile.passageIds
          .map((id) => previousPassages.get(id))
          .filter((passage): passage is Passage => Boolean(passage));
        if (passages.length > 0) {
          fetched.push({
            file: {
              ok: true,
              path: entry.path,
              language: passages[0]?.language ?? 'text',
              family: priorFile.kind === 'markdown' ? 'markdown' : priorFile.kind === 'code' ? 'code' : priorFile.kind === 'data' ? 'data' : 'text',
              kind: priorFile.kind,
              text: '',
              lineCount: priorFile.lineCount,
              truncated: priorFile.truncated,
              title: priorFile.title,
            },
            sha: entry.sha,
            size: entry.size ?? 0,
            reusedPassages: passages,
          });
          bytes += entry.size ?? 0;
          continue;
        }
      }
      toFetch.push(entry);
    }

    let fetchFailures = 0;
    await mapLimit(toFetch, this.github.authenticated ? 6 : 3, async (entry) => {
      try {
        const content = await this.github.getRawFile(owner, repo, entry.path, resolvedRef);
        const parsed = parseFile(entry.path, content, this.config.maxFileBytes);
        if (!parsed.ok) {
          skipped.push({ path: entry.path, reason: parsed.reason });
          return;
        }
        fetched.push({ file: parsed, sha: entry.sha, size: Buffer.byteLength(content, 'utf8') });
        bytes += Buffer.byteLength(content, 'utf8');
      } catch (error) {
        fetchFailures += 1;
        skipped.push({ path: entry.path, reason: error instanceof Error ? truncate(error.message, 120) : 'fetch_failed' });
      }
    });

    if (fetchFailures > 0) {
      this.logger.warn('some GitHub files could not be fetched', { name: source.name, fetchFailures });
    }
    if (fetched.length === 0) {
      throw new UpstreamError(
        toFetch.length === 0
          ? 'No readable text files were found in that repository (binary/asset-only repositories cannot be indexed).'
          : 'Every file fetch failed, so no knowledge could be indexed.',
        'github_no_indexable_files',
        true,
      );
    }

    const index = this.assembleIndex(source, resolvedRef, fetched, skipped, { truncatedTree: tree.truncated });
    return index;
  }

  private selectGitHubFiles(entries: TreeEntry[], truncatedTree: boolean): TreeEntry[] {
    void truncatedTree;
    const usable: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.type !== 'blob') continue;
      const size = entry.size ?? 0;
      if (size === 0 || size > this.config.maxFileBytes) continue;
      if (isSkippablePath(entry.path, { includeAppSources: this.includeAppSources })) continue;
      if (fileFamily(entry.path) === 'unsupported') continue;
      usable.push(entry);
    }
    usable.sort((a, b) => filePriority(b.path, b.size ?? 0) - filePriority(a.path, a.size ?? 0));
    let total = 0;
    const selected: TreeEntry[] = [];
    for (const entry of usable) {
      if (selected.length >= this.config.maxFilesPerSource) break;
      if (total + (entry.size ?? 0) > this.config.maxSourceBytes) continue;
      total += entry.size ?? 0;
      selected.push(entry);
    }
    return selected;
  }

  /* ------------------------------------------------------------------ */
  /* Local indexing                                                      */
  /* ------------------------------------------------------------------ */

  private async indexLocal(source: StoredSource): Promise<SourceIndex> {
    const root = source.localPath;
    if (!root) throw new ValidationError('This local source has no directory.');
    const candidates = await this.walkDirectory(root);
    const previous = this.indexes.get(source.id);
    const previousByPath = new Map(previous?.files.map((file) => [file.path, file]) ?? []);
    const previousPassages = new Map(previous?.passages.map((passage) => [passage.id, passage]) ?? []);

    const fetched: Array<{ file: ParsedFile; sha: string | null; size: number; reusedPassages?: Passage[] }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let bytes = 0;

    for (const relativePath of candidates) {
      const absolute = path.join(root, relativePath);
      let stat;
      try {
        stat = await fs.stat(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0 || stat.size > this.config.maxFileBytes) continue;
      if (isSkippablePath(relativePath, { includeAppSources: this.includeAppSources })) continue;
      if (fileFamily(relativePath) === 'unsupported') continue;
      let content: string;
      try {
        content = await fs.readFile(absolute, 'utf8');
      } catch {
        skipped.push({ path: relativePath, reason: 'unreadable' });
        continue;
      }
      const digest = sha256(content);
      const prior = previousByPath.get(relativePath);
      if (prior && prior.sha === digest) {
        const passages = prior.passageIds
          .map((id) => previousPassages.get(id))
          .filter((passage): passage is Passage => Boolean(passage));
        if (passages.length > 0) {
          fetched.push({
            file: {
              ok: true,
              path: relativePath,
              language: passages[0]?.language ?? 'text',
              family: prior.kind === 'markdown' ? 'markdown' : prior.kind === 'code' ? 'code' : prior.kind === 'data' ? 'data' : 'text',
              kind: prior.kind,
              text: '',
              lineCount: prior.lineCount,
              truncated: prior.truncated,
              title: prior.title,
            },
            sha: digest,
            size: stat.size,
            reusedPassages: passages,
          });
          bytes += stat.size;
          continue;
        }
      }
      const parsed = parseFile(relativePath, content, this.config.maxFileBytes);
      if (!parsed.ok) {
        skipped.push({ path: relativePath, reason: parsed.reason });
        continue;
      }
      fetched.push({ file: parsed, sha: digest, size: stat.size });
      bytes += stat.size;
      if (fetched.length >= this.config.maxFilesPerSource) break;
    }

    if (fetched.length === 0) {
      throw new UpstreamError('No readable text files were found in that directory.', 'local_no_files', false);
    }
    return this.assembleIndex(source, 'local', fetched, skipped, { truncatedTree: false });
  }

  private async walkDirectory(root: string): Promise<string[]> {
    const out: string[] = [];
    const queue: string[] = [''];
    const skipDirs = new Set([
      '.git', 'node_modules', 'dist', 'dist-server', 'build', '.data', '.next', 'coverage',
      '__pycache__', '.venv', 'venv', '.cache', 'vendor', '.idea', '.vscode', 'target', 'out',
    ]);
    let scanned = 0;
    while (queue.length > 0 && out.length < this.config.maxFilesPerSource * 3) {
      const current = queue.shift() as string;
      let entries;
      try {
        entries = await fs.readdir(path.join(root, current), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > this.config.maxTreeEntries * 4) break;
        const rel = current ? `${current}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (skipDirs.has(entry.name) || entry.name.startsWith('.')) continue;
          queue.push(rel);
        } else if (entry.isFile()) {
          if (entry.name.startsWith('.') && !['.gitattributes', '.gitignore', '.env.example'].includes(entry.name)) continue;
          out.push(rel);
        }
      }
    }
    out.sort((a, b) => filePriority(b, 1000) - filePriority(a, 1000));
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Assembly                                                            */
  /* ------------------------------------------------------------------ */

  private assembleIndex(
    source: StoredSource,
    resolvedRef: string,
    fetched: Array<{ file: ParsedFile; sha: string | null; size: number; reusedPassages?: Passage[] }>,
    skipped: Array<{ path: string; reason: string }>,
    meta: { truncatedTree: boolean },
  ): SourceIndex {
    const files: SourceIndexFile[] = [];
    const passages: Passage[] = [];
    let truncatedFiles = 0;
    let bytes = 0;

    for (const item of fetched) {
      const remaining = this.config.maxChunksPerSource - passages.length;
      if (remaining <= 0) break;
      let filePassages: Passage[];
      if (item.reusedPassages && item.reusedPassages.length > 0) {
        filePassages = item.reusedPassages;
      } else {
        filePassages = buildPassages(source.id, item.file, null, { maxChunks: remaining });
        if (item.file.truncated) truncatedFiles += 1;
      }
      const limited = filePassages.slice(0, remaining);
      passages.push(...limited);
      const kind: ChunkKind = item.file.kind;
      files.push({
        path: item.file.path,
        size: item.size,
        sha: item.sha,
        language: item.file.language,
        kind,
        lineCount: item.file.lineCount,
        passageIds: limited.map((passage) => passage.id),
        title: item.file.title,
        truncated: item.file.truncated,
        htmlUrl:
          source.kind === 'github' && source.owner && source.repo
            ? `https://github.com/${source.owner}/${source.repo}/blob/${resolvedRef}/${item.file.path}`
            : null,
      });
      bytes += item.size;
    }

    const { postings, docFreq, avgLength, totalLength } = buildInvertedIndex(source.id, files, passages);
    source.skipped = skipped.slice(0, MAX_SKIPPED_RECORDS);
    source.treeSha = resolvedRef;

    return {
      sourceId: source.id,
      builtAt: new Date().toISOString(),
      ref: source.ref ?? resolvedRef,
      resolvedRef,
      files,
      passages,
      postings,
      docFreq,
      avgLength,
      totalLength,
      stats: {
        filesIndexed: files.length,
        passages: passages.length,
        bytes,
        skipped: skipped.length,
        truncatedTree: meta.truncatedTree,
        truncatedFiles,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Browsing                                                            */
  /* ------------------------------------------------------------------ */

  async listDirectory(sourceId: string, dirPath: string): Promise<{ entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }>; truncated: boolean }> {
    const index = this.indexes.get(sourceId);
    const source = this.sources.get(sourceId);
    if (!source) throw new NotFoundError('That knowledge source does not exist.');
    if (!index) throw new UpstreamError('This source has no index yet. Re-index it first.', 'no_index', true);

    const normalized = dirPath.replace(/^\/+|\/+$/g, '');
    const prefix = normalized ? `${normalized}/` : '';
    const seen = new Set<string>();
    const entries: Array<{ path: string; type: 'file' | 'dir'; size?: number }> = [];
    for (const file of index.files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (seen.has(rest)) continue;
        seen.add(rest);
        entries.push({ path: file.path, type: 'file', size: file.size });
      } else {
        const dir = rest.slice(0, slash);
        if (seen.has(dir)) continue;
        seen.add(dir);
        entries.push({ path: `${prefix}${dir}`, type: 'dir' });
      }
    }
    entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
    return { entries: entries.slice(0, 500), truncated: entries.length > 500 };
  }

  /** Returns stored index metadata for a file (no network needed). */
  async readFile(sourceId: string, filePath: string): Promise<{ content: string; language: string; kind: ChunkKind; size: number; htmlUrl: string | null; truncated: boolean }> {
    const source = this.sources.get(sourceId);
    const index = this.indexes.get(sourceId);
    if (!source) throw new NotFoundError('That knowledge source does not exist.');
    if (!index) throw new UpstreamError('This source has no index yet.', 'no_index', true);
    const file = index.files.find((entry) => entry.path === filePath);
    if (!file) throw new NotFoundError('That file is not part of the indexed knowledge.');

    if (source.kind === 'github' && source.owner && source.repo) {
      const content = await this.github.getRawFile(source.owner, source.repo, filePath, index.resolvedRef);
      const limited = content.length > this.config.maxFileBytes ? content.slice(0, this.config.maxFileBytes) : content;
      return {
        content: limited,
        language: file.language,
        kind: file.kind,
        size: Buffer.byteLength(content, 'utf8'),
        htmlUrl: file.htmlUrl,
        truncated: content.length > this.config.maxFileBytes,
      };
    }
    if (!source.localPath) throw new NotFoundError('This source has no readable directory.');
    const absolute = path.resolve(source.localPath, filePath);
    if (!absolute.startsWith(path.resolve(source.localPath))) {
      throw new ValidationError('Invalid file path.');
    }
    const content = await fs.readFile(absolute, 'utf8').catch(() => null);
    if (content === null) throw new NotFoundError('That file could not be read from the local directory.');
    return {
      content: content.slice(0, this.config.maxFileBytes),
      language: file.language,
      kind: file.kind,
      size: Buffer.byteLength(content, 'utf8'),
      htmlUrl: file.htmlUrl,
      truncated: content.length > this.config.maxFileBytes,
    };
  }

  private persistSources(): void {
    const payload: SourcesFile = {
      version: 1,
      sources: [...this.sources.values()],
    };
    try {
      this.store.write(SOURCES_FILE, payload);
    } catch (error) {
      this.logger.error('could not persist knowledge sources', { error });
    }
  }
}

const SKIP_PATH_PARTS = [
  'node_modules/', '/node_modules/', 'dist/', 'dist-server/', 'build/', 'coverage/',
  '__pycache__/', '.git/', '/vendor/', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
];

/**
 * The assistant's own implementation. Indexing it would let the retriever match
 * its own source (sample questions, vocabulary lists, error strings) instead of
 * the user's documentation. Operators can opt in with IDOL_INDEX_APP_SOURCES=1.
 */
const APP_SOURCE_PREFIXES = ['server/', 'web/', 'shared/', 'tests/', 'scripts/', 'data/'];

export function isSkippablePath(filePath: string, options: { includeAppSources?: boolean } = {}): boolean {
  const lower = filePath.toLowerCase();
  if (SKIP_PATH_PARTS.some((part) => lower.startsWith(part) || lower.includes(`/${part}`))) return true;
  if (options.includeAppSources === true) return false;
  if (APP_SOURCE_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix))) return true;
  if (lower.endsWith('tsconfig.json') || lower.startsWith('tsconfig') || lower === 'vite.config.ts') return true;
  return false;
}

export { INDEX_VERSION };
export type { StoredSource };
export { SOURCES_FILE };
