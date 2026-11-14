/**
 * Atomic JSON persistence in the server data directory.
 *
 * Writes go to a temp file in the same directory and are then renamed, so a
 * crash can never leave a half-written index behind. All reads are defensive:
 * a corrupt file is reported and treated as absent rather than crashing boot.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../logger.js';

export class JsonStore {
  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
  ) {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  resolve(name: string): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`Unsafe store file name: ${name}`);
    return path.join(this.dataDir, name);
  }

  exists(name: string): boolean {
    try {
      return fs.statSync(this.resolve(name)).isFile();
    } catch {
      return false;
    }
  }

  read<T>(name: string, fallback: T): T {
    const file = this.resolve(name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn('could not read store file', { name, error });
      }
      return fallback;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.error('store file is corrupt; ignoring its contents', { name, error });
      try {
        fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch {
        /* best effort */
      }
      return fallback;
    }
  }

  write(name: string, value: unknown): void {
    const file = this.resolve(name);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify(value);
    fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  remove(name: string): void {
    try {
      fs.unlinkSync(this.resolve(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  size(name: string): number {
    try {
      return fs.statSync(this.resolve(name)).size;
    } catch {
      return 0;
    }
  }
}
