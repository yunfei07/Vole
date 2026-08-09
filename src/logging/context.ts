import { AsyncLocalStorage } from 'node:async_hooks';
import type { VoleLogger } from './logger.js';
import { createWorkerLogger, getNoopLogger, type VoleLoggerContext } from './logger.js';

export const INTERNAL_LOG_CONTEXT_ENV = 'VOLE_INTERNAL_LOG_CONTEXT';

const storage = new AsyncLocalStorage<VoleLogger>();
let workerLogger: VoleLogger | undefined;

export function getLogger(): VoleLogger {
  return storage.getStore() ?? getNoopLogger();
}

export function runWithLogger<T>(logger: VoleLogger, execute: () => T): T {
  return storage.run(logger, execute);
}

export function internalLogEnvironment(logger: VoleLogger): Record<string, string> {
  const context = logger.context();
  return context && logger.logPath
    ? { [INTERNAL_LOG_CONTEXT_ENV]: JSON.stringify(context) }
    : {};
}

export function runtimeLogger(explicit?: VoleLogger): VoleLogger {
  if (explicit) return explicit;
  const current = storage.getStore();
  if (current) return current;
  if (workerLogger) return workerLogger;
  const serialized = process.env[INTERNAL_LOG_CONTEXT_ENV];
  if (!serialized) return getNoopLogger();
  try {
    const value = JSON.parse(serialized) as VoleLoggerContext;
    if (!validWorkerContext(value)) return getNoopLogger();
    workerLogger = createWorkerLogger(value);
    return workerLogger;
  } catch {
    return getNoopLogger();
  }
}

function validWorkerContext(value: VoleLoggerContext): boolean {
  return Boolean(
    value &&
    typeof value.invocationId === 'string' &&
    typeof value.command === 'string' &&
    typeof value.rootDirectory === 'string' &&
    typeof value.dateDirectory === 'string' &&
    ['debug', 'info', 'warn', 'error'].includes(value.level) &&
    Number.isSafeInteger(value.maxFileSizeBytes) &&
    value.maxFileSizeBytes > 0
  );
}
