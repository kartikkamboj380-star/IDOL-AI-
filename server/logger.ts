/** Structured, dependency-free logger with secret redaction. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/g,
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message) };
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeValue(v);
    return out;
  }
  return value;
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly minLevel: LogLevel = 'info',
    private readonly json: boolean = false,
  ) {}

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const time = new Date().toISOString();
    const safeMessage = redact(message);
    const safeFields = fields ? (sanitizeValue(fields) as Record<string, unknown>) : undefined;
    if (this.json) {
      process.stdout.write(
        `${JSON.stringify({ time, level, scope: this.scope, message: safeMessage, ...safeFields })}\n`,
      );
      return;
    }
    const suffix = safeFields && Object.keys(safeFields).length > 0 ? ` ${JSON.stringify(safeFields)}` : '';
    process.stdout.write(`${time} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${safeMessage}${suffix}\n`);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }
  child(scope: string): Logger {
    return new Logger(`${this.scope}:${scope}`, this.minLevel, this.json);
  }
}

export function createLogger(nodeEnv: string): Logger {
  const level = (process.env.IDOL_LOG_LEVEL as LogLevel | undefined) ?? (nodeEnv === 'production' ? 'info' : 'debug');
  return new Logger('idol', level, nodeEnv === 'production');
}
