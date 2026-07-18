import { createHash } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists } from '../utils/fs.js';
import type { ModelToolCall } from './model-client.js';
import type { AiAction, AiActionMethod, AiAgentHistoryItem, LocatorDescriptor } from './types.js';

const CACHE_VERSION = 2;

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

export type CachedAgentDecision = {
  version: number;
  key: string;
  toolCalls: ModelToolCall[];
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
    variables?: Record<string, string>;
  }): string {
    const instruction = redactVariableValues(input.instruction, input.variables);
    return createHash('sha256')
      .update(JSON.stringify({
        version: CACHE_VERSION,
        instruction: normalizeInstruction(instruction),
        url: normalizeUrl(input.url),
        pageFingerprint: input.pageFingerprint,
        model: input.model,
        variableNames: Object.keys(input.variables ?? {}).sort()
      }))
      .digest('hex');
  }

  async get(key: string): Promise<CachedAction | undefined> {
    const filePath = this.filePath(key);
    if (!(await pathExists(filePath))) {
      return undefined;
    }
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8')) as CachedAction;
      if (value.version !== CACHE_VERSION || value.key !== key) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
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

  async getAgentDecision(key: string): Promise<CachedAgentDecision | undefined> {
    const filePath = this.agentFilePath(key);
    if (!(await pathExists(filePath))) {
      return undefined;
    }
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8')) as CachedAgentDecision;
      if (
        value.version !== CACHE_VERSION ||
        value.key !== key ||
        !Array.isArray(value.toolCalls)
      ) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  async setAgentDecision(
    input: Omit<CachedAgentDecision, 'version' | 'createdAt' | 'updatedAt'>
  ): Promise<void> {
    await ensureDir(this.rootDir);
    const existing = await this.getAgentDecision(input.key);
    const now = new Date().toISOString();
    const value: CachedAgentDecision = {
      ...input,
      version: CACHE_VERSION,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const filePath = this.agentFilePath(input.key);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  }

  async deleteAgentDecision(key: string): Promise<void> {
    await unlink(this.agentFilePath(key)).catch(() => undefined);
  }

  async getAgentTrajectory(key: string): Promise<CachedAgentTrajectory | undefined> {
    const filePath = this.trajectoryFilePath(key);
    if (!(await pathExists(filePath))) {
      return undefined;
    }
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8')) as CachedAgentTrajectory;
      return value.version === CACHE_VERSION &&
        value.key === key &&
        Array.isArray(value.history)
        ? value
        : undefined;
    } catch {
      return undefined;
    }
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

  private filePath(key: string): string {
    return path.join(this.rootDir, `${key}.json`);
  }

  private agentFilePath(key: string): string {
    return path.join(this.rootDir, `${key}.agent.json`);
  }

  private trajectoryFilePath(key: string): string {
    return path.join(this.rootDir, `${key}.trajectory.json`);
  }
}

export function redactVariableValues(
  input: string,
  variables?: Record<string, string>
): string {
  return Object.entries(variables ?? {})
    .filter(([, value]) => value.length > 0)
    .sort((left, right) => right[1].length - left[1].length)
    .reduce(
      (result, [key, value]) => result.split(value).join(`\${${key}}`),
      input
    );
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
