import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { configRelativePath } from '../config/load-config.js';
import { defaultLoggingConfig, loggingConfigSchema, type LoggingConfig } from './config.js';
import { runWithLogger } from './context.js';
import { createCommandLogger } from './logger.js';

const loggedErrors = new WeakSet<object>();

export async function runLoggedCommand<T>(
  command: string,
  execute: () => Promise<T>,
  cwd = process.cwd()
): Promise<T> {
  const resolved = await resolveLoggingConfig(cwd);
  const logger = createCommandLogger({ cwd, command, config: resolved.config });
  const startedAt = Date.now();
  return runWithLogger(logger, async () => {
    if (resolved.error) {
      logger.warn('logging.config_invalid', {
        component: 'config',
        message: 'Invalid logging configuration; using defaults',
        error: resolved.error
      });
    }
    logger.info('command.started');
    try {
      const result = await execute();
      const exitCode = process.exitCode ?? 0;
      logger.info('command.completed', {
        durationMs: Date.now() - startedAt,
        outcome: exitCode === 0 ? 'success' : 'failed',
        exitCode
      });
      return result;
    } catch (error) {
      logger.error('command.failed', {
        message: 'Command failed',
        terminalMessage: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
        outcome: 'failed',
        error
      });
      markLogged(error);
      if (logger.logPath) {
        process.stderr.write(`日志：${path.relative(cwd, path.dirname(logger.logPath))}\n`);
      }
      throw error;
    } finally {
      await logger.close();
    }
  });
}

export function wasErrorLogged(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && loggedErrors.has(error));
}

async function resolveLoggingConfig(cwd: string): Promise<{ config: LoggingConfig; error?: Error }> {
  try {
    const raw = JSON.parse(await readFile(path.resolve(cwd, configRelativePath), 'utf8')) as { logging?: unknown };
    return { config: loggingConfigSchema.parse(raw.logging ?? {}) };
  } catch (error) {
    const value = error as NodeJS.ErrnoException;
    if (value?.code === 'ENOENT') return { config: defaultLoggingConfig };
    return {
      config: defaultLoggingConfig,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

function markLogged(error: unknown): void {
  if (error && typeof error === 'object') loggedErrors.add(error);
}
