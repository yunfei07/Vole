import path from 'node:path';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { voleConfigSchema, type VoleConfig } from './schema.js';

export const configRelativePath = '.vole/vole.config.json';
export const legacyConfigRelativePath = 'vole.config.json';

export async function loadConfig(cwd = process.cwd()): Promise<VoleConfig> {
  const configPath = await resolveConfigPath(cwd);
  const rawConfig = await readJsonFile<unknown>(configPath);
  return voleConfigSchema.parse(rawConfig);
}

export async function resolveConfigPath(cwd = process.cwd()): Promise<string> {
  const configPath = path.resolve(cwd, configRelativePath);
  if (await pathExists(configPath)) {
    return configPath;
  }

  const legacyConfigPath = path.resolve(cwd, legacyConfigRelativePath);
  return await pathExists(legacyConfigPath) ? legacyConfigPath : configPath;
}
