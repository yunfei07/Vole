import path from 'node:path';
import { getLogger } from '../logging/context.js';
import { readJsonFile } from '../utils/fs.js';
import { voleConfigSchema, type VoleConfig } from './schema.js';

export const configRelativePath = '.vole/vole.config.json';

export async function loadConfig(cwd = process.cwd()): Promise<VoleConfig> {
  const configPath = await resolveConfigPath(cwd);
  const logger = getLogger().child({ component: 'config' });
  const startedAt = Date.now();
  try {
    const rawConfig = await readJsonFile<unknown>(configPath);
    const config = voleConfigSchema.parse(rawConfig);
    logger.info('config.loaded', {
      configPath,
      durationMs: Date.now() - startedAt
    });
    return config;
  } catch (error) {
    logger.error('config.load_failed', {
      message: 'Failed to load Vole configuration',
      configPath,
      durationMs: Date.now() - startedAt,
      error
    });
    throw error;
  }
}

export async function resolveConfigPath(cwd = process.cwd()): Promise<string> {
  return path.resolve(cwd, configRelativePath);
}
