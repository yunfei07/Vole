import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, rmdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { LogLevel, LoggingConfig } from './config.js';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const MAX_STRING_LENGTH = 4096;
const SENSITIVE_KEYS = new Set([
  'apikey', 'api-key', 'api_key', 'authorization', 'cookie', 'cookies',
  'password', 'passwd', 'secret', 'token', 'access-token', 'access_token',
  'refreshtoken', 'refresh-token', 'refresh_token', 'storagestate',
  'storage-state', 'storage_state', 'prompt', 'messages', 'response',
  'responsemessages', 'snapshot', 'pagetext', 'html', 'content', 'base64', 'value',
  'terminalmessage'
]);
const OWNED_FILE_PATTERN = /^(?:cli|worker-\d+)(?:\.part-\d+)?\.jsonl$/u;
const DATE_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const INVOCATION_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type LogFields = Record<string, unknown>;

export type VoleLoggerContext = {
  invocationId: string;
  command: string;
  rootDirectory: string;
  dateDirectory: string;
  level: LogLevel;
  maxFileSizeBytes: number;
};

export interface VoleLogger {
  readonly invocationId?: string;
  readonly logPath?: string;
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): VoleLogger;
  flush(): Promise<void>;
  close(): Promise<void>;
  context(): VoleLoggerContext | undefined;
}

type LoggerState = {
  enabled: boolean;
  level: LogLevel;
  directory: string;
  baseName: string;
  maxFileSizeBytes: number;
  part: number;
  currentSize: number;
  queue: Promise<void>;
  closed: boolean;
  failureReported: boolean;
  context?: VoleLoggerContext;
};

export type JsonlLoggerOptions = {
  enabled?: boolean;
  level: LogLevel;
  directory: string;
  baseName: string;
  maxFileSizeBytes: number;
  bindings: LogFields;
  context?: VoleLoggerContext;
  beforeWrite?: () => Promise<void>;
};

class JsonlLogger implements VoleLogger {
  readonly invocationId?: string;

  constructor(
    private readonly state: LoggerState,
    private readonly bindings: LogFields
  ) {
    this.invocationId = state.context?.invocationId;
  }

  get logPath(): string | undefined {
    if (!this.state.enabled) return undefined;
    return filePath(this.state);
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write('debug', event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: LogFields = {}): void {
    this.write('error', event, fields);
  }

  child(bindings: LogFields): VoleLogger {
    return new JsonlLogger(this.state, { ...this.bindings, ...sanitizeRecord(bindings) });
  }

  async flush(): Promise<void> {
    await this.state.queue;
  }

  async close(): Promise<void> {
    this.state.closed = true;
    await this.flush();
  }

  context(): VoleLoggerContext | undefined {
    return this.state.context;
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (this.state.closed || LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.state.level]) return;
    const terminalMessage = typeof fields.terminalMessage === 'string'
      ? safeString(redactText(fields.terminalMessage))
      : undefined;
    const safeFields = sanitizeRecord(fields);
    const entry = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      level,
      event: safeString(event),
      ...this.bindings,
      ...safeFields
    };
    const line = `${JSON.stringify(entry)}\n`;

    if (level === 'warn' || level === 'error') {
      const message = terminalMessage ?? (typeof safeFields.message === 'string' ? safeFields.message : event);
      process.stderr.write(`[vole] ${message}\n`);
    }
    if (!this.state.enabled) return;

    this.state.queue = this.state.queue
      .then(async () => {
        const bytes = Buffer.byteLength(line);
        if (this.state.currentSize > 0 && this.state.currentSize + bytes > this.state.maxFileSizeBytes) {
          this.state.part += 1;
          this.state.currentSize = 0;
        }
        await mkdir(this.state.directory, { recursive: true });
        await appendFile(filePath(this.state), line, 'utf8');
        this.state.currentSize += bytes;
      })
      .catch((error: unknown) => reportWriteFailure(this.state, error));
  }
}

export function createJsonlLogger(options: JsonlLoggerOptions): VoleLogger {
  const state: LoggerState = {
    enabled: options.enabled ?? true,
    level: options.level,
    directory: options.directory,
    baseName: options.baseName,
    maxFileSizeBytes: options.maxFileSizeBytes,
    part: 1,
    currentSize: 0,
    queue: Promise.resolve(),
    closed: false,
    failureReported: false,
    context: options.context
  };
  if (options.beforeWrite) {
    state.queue = options.beforeWrite().catch((error: unknown) => reportWriteFailure(state, error));
  }
  return new JsonlLogger(state, sanitizeRecord(options.bindings));
}

export function createCommandLogger(input: {
  cwd: string;
  command: string;
  config: LoggingConfig;
  invocationId?: string;
  now?: Date;
}): VoleLogger {
  const now = input.now ?? new Date();
  const invocationId = input.invocationId ?? randomUUID();
  const rootDirectory = path.resolve(input.cwd, input.config.directory);
  const dateDirectory = now.toISOString().slice(0, 10);
  const directory = path.join(rootDirectory, dateDirectory, invocationId);
  const context: VoleLoggerContext = {
    invocationId,
    command: input.command,
    rootDirectory,
    dateDirectory,
    level: input.config.level,
    maxFileSizeBytes: Math.max(1, Math.floor(input.config.maxFileSizeMb * 1024 * 1024))
  };
  return createJsonlLogger({
    enabled: input.config.enabled,
    level: input.config.level,
    directory,
    baseName: 'cli',
    maxFileSizeBytes: context.maxFileSizeBytes,
    bindings: {
      invocationId,
      command: input.command,
      component: 'cli',
      pid: process.pid
    },
    context,
    beforeWrite: input.config.enabled
      ? () => cleanupExpiredLogs(rootDirectory, input.config.retentionDays, now)
      : undefined
  });
}

export function createWorkerLogger(context: VoleLoggerContext): VoleLogger {
  return createJsonlLogger({
    level: context.level,
    directory: path.join(context.rootDirectory, context.dateDirectory, context.invocationId),
    baseName: `worker-${process.pid}`,
    maxFileSizeBytes: context.maxFileSizeBytes,
    bindings: {
      invocationId: context.invocationId,
      command: context.command,
      component: 'runtime-ai',
      pid: process.pid
    },
    context
  });
}

export function sanitizeLogValue(value: unknown, key?: string): unknown {
  const normalizedKey = key?.toLowerCase().replace(/\s+/gu, '');
  if (normalizedKey && SENSITIVE_KEYS.has(normalizedKey)) return '[REDACTED]';
  if (value instanceof Error) return sanitizeError(value);
  if (typeof value === 'string') {
    if (key && /url$/iu.test(key)) return sanitizeUrl(value);
    return safeString(redactText(value));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeLogValue(item));
  if (value && typeof value === 'object') return sanitizeRecord(value as Record<string, unknown>);
  return value === undefined ? undefined : safeString(String(value));
}

export function hashSensitiveText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function cleanupExpiredLogs(rootDirectory: string, retentionDays: number, now = new Date()): Promise<void> {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const dateEntries = await readdir(rootDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const dateEntry of dateEntries) {
    if (!dateEntry.isDirectory() || !DATE_DIRECTORY_PATTERN.test(dateEntry.name)) continue;
    const datePath = path.join(rootDirectory, dateEntry.name);
    const invocationEntries = await readdir(datePath, { withFileTypes: true });
    for (const invocationEntry of invocationEntries) {
      if (!invocationEntry.isDirectory() || !INVOCATION_DIRECTORY_PATTERN.test(invocationEntry.name)) continue;
      const invocationPath = path.join(datePath, invocationEntry.name);
      const files = await readdir(invocationPath, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || !OWNED_FILE_PATTERN.test(file.name)) continue;
        const ownedPath = path.join(invocationPath, file.name);
        const details = await stat(ownedPath);
        if (details.mtimeMs < cutoff) await unlink(ownedPath);
      }
      await rmdir(invocationPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
      });
    }
    await rmdir(datePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
    });
  }
}

function sanitizeRecord(value: Record<string, unknown>): LogFields {
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, sanitizeLogValue(item, key)] as const)
      .filter((entry) => entry[1] !== undefined)
  );
}

function sanitizeError(error: Error): LogFields {
  const code = (error as Error & { code?: unknown }).code;
  if (
    error.name === 'AiRuntimeError' ||
    (typeof code === 'string' && code.startsWith('AI_'))
  ) {
    return {
      name: safeString(error.name),
      ...(code !== undefined ? { code: sanitizeLogValue(code, 'code') } : {}),
      messageHash: hashSensitiveText(error.message),
      ...(error.stack ? { stackHash: hashSensitiveText(error.stack) } : {})
    };
  }
  return {
    name: safeString(error.name),
    ...(code !== undefined ? { code: sanitizeLogValue(code, 'code') } : {}),
    message: safeString(redactText(error.message)),
    ...(error.stack ? { stack: safeString(redactText(error.stack)) } : {})
  };
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return safeString(value.split(/[?#]/u, 1)[0]);
  }
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/([?&](?:api_?key|token|password|secret)=)[^&#\s]*/giu, '$1[REDACTED]')
    .replace(/((?:api_?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

function safeString(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}…[truncated:${value.length}]`;
}

function filePath(state: LoggerState): string {
  const suffix = state.part === 1 ? '' : `.part-${state.part}`;
  return path.join(state.directory, `${state.baseName}${suffix}.jsonl`);
}

function reportWriteFailure(state: LoggerState, error: unknown): void {
  if (state.failureReported) return;
  state.failureReported = true;
  const message = error instanceof Error ? redactText(error.message) : String(error);
  process.stderr.write(`[vole] logging unavailable: ${safeString(message)}\n`);
}

const noopLogger: VoleLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  flush: async () => undefined,
  close: async () => undefined,
  context: () => undefined
};

export function getNoopLogger(): VoleLogger {
  return noopLogger;
}
