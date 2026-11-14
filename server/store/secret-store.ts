/**
 * Server-side secret storage for an optional GitHub token supplied by the
 * operator at runtime (never by the browser).
 *
 * Precedence: environment variable > encrypted file in the data directory.
 * The file is written with mode 0600 and obfuscated with a key derived from a
 * local secret file; this is defence-in-depth, not a substitute for OS-level
 * filesystem permissions. Tokens are never returned by any API endpoint.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import type { Logger } from '../logger.js';

const TOKEN_FILE = 'github-token.enc';
const KEY_FILE = 'server.key';
const CIPHER = 'aes-256-gcm';

interface StoredToken {
  token: string;
  savedAt: string;
  /** Only non-secret metadata is ever exposed to the client. */
  login?: string;
  scopes?: string;
}

export class SecretStore {
  private readonly tokenPath: string;
  private readonly keyPath: string;
  private cachedToken: string | null | undefined;
  private meta: { savedAt: string; login?: string; scopes?: string } | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly envToken: string | null,
    private readonly logger: Logger,
  ) {
    this.tokenPath = path.join(dataDir, TOKEN_FILE);
    this.keyPath = path.join(dataDir, KEY_FILE);
  }

  get hasEnvToken(): boolean {
    return Boolean(this.envToken);
  }

  /** True when a token is available from env or the encrypted store. */
  hasToken(): boolean {
    return Boolean(this.getToken());
  }

  getToken(): string | null {
    if (this.envToken) return this.envToken;
    if (this.cachedToken !== undefined) return this.cachedToken;
    this.cachedToken = this.readStoredToken();
    return this.cachedToken;
  }

  /** Non-secret metadata (login, scopes, save time) for the status endpoint. */
  describe(): { source: 'env' | 'runtime' | 'none'; savedAt: string | null; login: string | null; scopes: string | null } {
    if (this.envToken) {
      return { source: 'env', savedAt: null, login: this.meta?.login ?? null, scopes: this.meta?.scopes ?? null };
    }
    const stored = this.readStoredToken();
    if (stored) {
      if (!this.meta) this.meta = this.readMeta();
      return {
        source: 'runtime',
        savedAt: this.meta?.savedAt ?? null,
        login: this.meta?.login ?? null,
        scopes: this.meta?.scopes ?? null,
      };
    }
    return { source: 'none', savedAt: null, login: null, scopes: null };
  }

  /**
   * Persist a runtime token. Validated by the caller (GitHub /user request)
   * before this is invoked, so we only store tokens that actually work.
   */
  save(token: string, meta: { login?: string; scopes?: string } = {}): void {
    if (this.envToken) {
      throw new Error('A GITHUB_TOKEN environment variable is already configured; runtime token storage is disabled.');
    }
    const trimmed = token.trim();
    if (!/^(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})$/.test(trimmed)) {
      throw new Error('That does not look like a GitHub personal access token.');
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
    const key = this.loadKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(CIPHER, key, iv);
    const payload = JSON.stringify({
      token: trimmed,
      savedAt: new Date().toISOString(),
      login: meta.login,
      scopes: meta.scopes,
    } satisfies StoredToken);
    const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const blob = Buffer.concat([iv, tag, encrypted]);
    fs.writeFileSync(this.tokenPath, blob, { mode: 0o600 });
    this.cachedToken = trimmed;
    this.meta = { savedAt: new Date().toISOString(), login: meta.login, scopes: meta.scopes };
    this.logger.info('stored runtime GitHub token', { login: meta.login ?? 'unknown' });
  }

  clear(): boolean {
    this.cachedToken = null;
    this.meta = null;
    try {
      fs.unlinkSync(this.tokenPath);
      return true;
    } catch {
      return false;
    }
  }

  private loadKey(): Buffer {
    fs.mkdirSync(this.dataDir, { recursive: true });
    try {
      const existing = fs.readFileSync(this.keyPath);
      if (existing.length >= 32) return existing.subarray(0, 32);
    } catch {
      /* generate below */
    }
    const key = randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  private derivKey(): Buffer {
    const key = this.loadKey();
    // scrypt with a static salt: the key file itself is the secret.
    return scryptSync(key, 'idol-ai-token-store', 32);
  }

  private readStoredToken(): string | null {
    let blob: Buffer;
    try {
      blob = fs.readFileSync(this.tokenPath);
    } catch {
      return null;
    }
    if (blob.length < 29) return null;
    try {
      const key = this.derivKey();
      const iv = blob.subarray(0, 12);
      const tag = blob.subarray(12, 28);
      const data = blob.subarray(28);
      const decipher = createDecipheriv(CIPHER, key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(json) as StoredToken;
      if (typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
      this.meta = { savedAt: parsed.savedAt, login: parsed.login, scopes: parsed.scopes };
      return parsed.token;
    } catch (error) {
      this.logger.warn('stored GitHub token could not be decrypted; ignoring it', { error });
      return null;
    }
  }

  private readMeta(): { savedAt: string; login?: string; scopes?: string } | null {
    try {
      this.readStoredToken();
    } catch {
      /* ignore */
    }
    return this.meta;
  }
}
