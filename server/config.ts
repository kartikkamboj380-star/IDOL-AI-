/**
 * Runtime configuration. Everything is optional except sane defaults; the app
 * must boot with zero environment variables and run in knowledge mode.
 */
import path from 'node:path';
import fs from 'node:fs';

export interface AppConfig {
  port: number;
  host: string;
  nodeEnv: string;
  version: string;
  dataDir: string;
  webDistDir: string;

  /** Optional GitHub token, server-side only. */
  githubToken: string | null;
  githubApiBase: string;
  /** owner/repo automatically registered on first boot, e.g. "kartikkamboj380-star/IDOL-AI-". */
  defaultRepo: string | null;
  defaultRef: string | null;

  /** Optional local knowledge directory (used for offline/self-hosted indexing). */
  localDir: string | null;
  /** Enables the local mirror fallback when GitHub cannot be reached. */
  allowLocalFallback: boolean;

  maxFilesPerSource: number;
  maxFileBytes: number;
  maxSourceBytes: number;
  maxChunksPerSource: number;
  maxTreeEntries: number;

  maxMessageChars: number;
  maxHistoryTurns: number;
  maxContextChars: number;
  requestTimeoutMs: number;

  /** Inbound rate limiting. */
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;

  /** Optional OpenAI-compatible inference provider. */
  inference: {
    provider: string | null;
    baseUrl: string | null;
    apiKey: string | null;
    model: string | null;
    maxTokens: number;
    temperature: number;
    timeoutMs: number;
  };
}

function intFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function floatFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function strFromEnv(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function resolveDataDir(): string {
  const configured = strFromEnv('IDOL_DATA_DIR');
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), '.data');
}

function resolveDefaultRepo(): string | null {
  const explicit = strFromEnv('IDOL_DEFAULT_REPO');
  if (explicit) return explicit;
  // Derive from the git remote when available so a fork indexes itself.
  try {
    const config = fs.readFileSync(path.resolve(process.cwd(), '.git', 'config'), 'utf8');
    const match = config.match(/url\s*=\s*(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\s*$/m);
    if (match?.[1] && match?.[2]) return `${match[1]}/${match[2]}`;
  } catch {
    /* not a git checkout, ignore */
  }
  return 'kartikkamboj380-star/IDOL-AI-';
}

function resolveLocalDir(): string | null {
  const explicit = strFromEnv('IDOL_LOCAL_DIR');
  if (explicit) return path.resolve(explicit);
  return null;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const localDir = resolveLocalDir();
  const allowsFallback = process.env.IDOL_ALLOW_LOCAL_FALLBACK !== '0';
  const inferenceKey = strFromEnv('IDOL_INFERENCE_API_KEY');
  const inferenceBase = strFromEnv('IDOL_INFERENCE_BASE_URL');
  const inferenceModel = strFromEnv('IDOL_INFERENCE_MODEL');

  const config: AppConfig = {
    port: intFromEnv('PORT', 8787, 1, 65535),
    host: strFromEnv('HOST') ?? '0.0.0.0',
    nodeEnv: process.env.NODE_ENV ?? 'development',
    version: readVersion(),
    dataDir: resolveDataDir(),
    webDistDir: path.resolve(process.cwd(), 'dist'),

    githubToken: strFromEnv('GITHUB_TOKEN') ?? strFromEnv('GH_TOKEN'),
    githubApiBase: strFromEnv('GITHUB_API_BASE') ?? 'https://api.github.com',
    defaultRepo: resolveDefaultRepo(),
    defaultRef: strFromEnv('IDOL_DEFAULT_REF'),

    localDir,
    allowLocalFallback: allowsFallback,

    maxFilesPerSource: intFromEnv('IDOL_MAX_FILES', 400, 1, 5000),
    maxFileBytes: intFromEnv('IDOL_MAX_FILE_BYTES', 400_000, 1024, 5_000_000),
    maxSourceBytes: intFromEnv('IDOL_MAX_SOURCE_BYTES', 24_000_000, 10_000, 500_000_000),
    maxChunksPerSource: intFromEnv('IDOL_MAX_CHUNKS', 12_000, 100, 200_000),
    maxTreeEntries: intFromEnv('IDOL_MAX_TREE_ENTRIES', 6000, 100, 100_000),

    maxMessageChars: intFromEnv('IDOL_MAX_MESSAGE_CHARS', 6000, 64, 100_000),
    maxHistoryTurns: intFromEnv('IDOL_MAX_HISTORY_TURNS', 12, 0, 100),
    maxContextChars: intFromEnv('IDOL_MAX_CONTEXT_CHARS', 14_000, 1000, 200_000),
    requestTimeoutMs: intFromEnv('IDOL_REQUEST_TIMEOUT_MS', 90_000, 1000, 600_000),

    rateLimitWindowMs: intFromEnv('IDOL_RATE_WINDOW_MS', 60_000, 1000, 3_600_000),
    rateLimitMaxRequests: intFromEnv('IDOL_RATE_MAX', 90, 1, 100_000),

    inference: {
      provider: strFromEnv('IDOL_INFERENCE_PROVIDER'),
      baseUrl: inferenceBase,
      apiKey: inferenceKey,
      model: inferenceModel,
      maxTokens: intFromEnv('IDOL_INFERENCE_MAX_TOKENS', 900, 64, 8192),
      temperature: floatFromEnv('IDOL_INFERENCE_TEMPERATURE', 0.2, 0, 2),
      timeoutMs: intFromEnv('IDOL_INFERENCE_TIMEOUT_MS', 60_000, 1000, 600_000),
    },
  };

  return { ...config, ...overrides };
}
