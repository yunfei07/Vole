import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runtimeLogger } from '../logging/context.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import type {
  AiAction,
  AiActionMethod,
  AiAgentHistoryItem,
  AiVariables,
  LocatorDescriptor
} from './types.js';
import { redactVariables } from './variables.js';

const CACHE_VERSION = 3;

export type CachedAction = {
  version: number;
  key: string;
  instruction: string;
  url: string;
  pageFingerprint: string;
  model: string;
  variableNames: string[];
  action: AiActionMethod;
  locator: LocatorDescriptor;
  actions?: AiAction[];
  createdAt: string;
  updatedAt: string;
};

export type CachedAgentTrajectory = {
  version: number;
  key: string;
  instruction: string;
  url: string;
  model: string;
  configSignature: string;
  variableNames: string[];
  history: AiAgentHistoryItem[];
  resultMessage: string;
  createdAt: string;
  updatedAt: string;
};

export class AiRuntimeCache {
  constructor(private readonly rootDir: string) {}

  createKey(input: {
    instruction: string;
    url: string;
    pageFingerprint: string;
    model: string;
    variables?: AiVariables;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify({
        version: CACHE_VERSION,
        instruction: normalizeInstruction(redactVariables(input.instruction, input.variables)),
        url: normalizeUrl(input.url),
        model: input.model,
        pageFingerprint: input.pageFingerprint,
        variableNames: Object.keys(input.variables ?? {}).sort()
      }))
      .digest('hex');
  }

  createAgentKey(input: {
    instruction: string;
    url: string;
    model: string;
    configSignature: string;
    variables?: AiVariables;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify({
        version: CACHE_VERSION,
        instruction: normalizeInstruction(redactVariables(input.instruction, input.variables)),
        url: normalizeUrl(input.url),
        model: input.model,
        configSignature: input.configSignature,
        variableNames: Object.keys(input.variables ?? {}).sort()
      }))
      .digest('hex');
  }

  async get(key: string): Promise<CachedAction | undefined> {
    const logger = runtimeLogger().child({ component: 'ai-cache' });
    const filePath = this.filePath(key);
    if (!(await pathExists(filePath))) {
      logger.debug('ai.cache_miss', { cacheKind: 'action', key });
      return undefined;
    }
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
    let value: CachedAction;
    try {
      value = JSON.parse(raw) as CachedAction;
    } catch (error) {
      await this.evictCorrupt(filePath, error);
      return undefined;
    }
    if (value.version !== CACHE_VERSION || value.key !== key) {
      logger.debug('ai.cache_stale', { cacheKind: 'action', key });
      return undefined;
    }
    logger.debug('ai.cache_hit', { cacheKind: 'action', key });
    return value;
  }

  async set(input: Omit<CachedAction, 'version' | 'createdAt' | 'updatedAt'>): Promise<void> {
    await ensureDir(this.rootDir);
    const existing = await this.get(input.key);
    const now = new Date().toISOString();
    const value: CachedAction = {
      ...input,
      version: CACHE_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const filePath = this.filePath(input.key);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  }

  async getAgentTrajectory(key: string): Promise<CachedAgentTrajectory | undefined> {
    const logger = runtimeLogger().child({ component: 'ai-cache' });
    const filePath = this.trajectoryFilePath(key);
    if (!(await pathExists(filePath))) {
      logger.debug('ai.cache_miss', { cacheKind: 'agent', key });
      return undefined;
    }
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch {
      return undefined;
    }
    let value: CachedAgentTrajectory;
    try {
      value = JSON.parse(raw) as CachedAgentTrajectory;
    } catch (error) {
      await this.evictCorrupt(filePath, error);
      return undefined;
    }
    const valid = value.version === CACHE_VERSION &&
      value.key === key &&
      Array.isArray(value.history)
      ? value
      : undefined;
    logger.debug(valid ? 'ai.cache_hit' : 'ai.cache_stale', { cacheKind: 'agent', key });
    return valid;
  }

  async setAgentTrajectory(
    input: Omit<CachedAgentTrajectory, 'version' | 'createdAt' | 'updatedAt'>
  ): Promise<void> {
    await ensureDir(this.rootDir);
    const existing = await this.getAgentTrajectory(input.key);
    const now = new Date().toISOString();
    const value: CachedAgentTrajectory = {
      ...input,
      version: CACHE_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const filePath = this.trajectoryFilePath(input.key);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  }

  async deleteAgentTrajectory(key: string): Promise<void> {
    await unlink(this.trajectoryFilePath(key)).catch(() => undefined);
  }

  private async evictCorrupt(filePath: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    runtimeLogger().child({ component: 'ai-cache' }).warn('ai.cache_corrupt', {
      message: `Discarding unreadable cache file: ${message}`,
      cachePath: filePath,
      error
    });
    await unlink(filePath).catch(() => undefined);
  }

  private filePath(key: string): string {
    return path.join(this.rootDir, `${key}.json`);
  }

  private trajectoryFilePath(key: string): string {
    return path.join(this.rootDir, `${key}.trajectory.json`);
  }
}

export function redactVariableValues(
  input: string,
  variables?: AiVariables
): string {
  return redactVariables(input, variables);
}

function normalizeInstruction(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function normalizeUrl(input: string): string {
  try {
    const url = new URL(input);
    url.hash = '';
    return url.toString();
  } catch {
    return input;
  }
}
