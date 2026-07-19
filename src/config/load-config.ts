import path from 'node:path';
import { readJsonFile } from '../utils/fs.js';
import { voleConfigSchema, type VoleConfig } from './schema.js';

export const configRelativePath = '.vole/vole.config.json';

export async function loadConfig(cwd = process.cwd()): Promise<VoleConfig> {
  const configPath = await resolveConfigPath(cwd);
  const rawConfig = await readJsonFile<unknown>(configPath);
  return voleConfigSchema.parse(rawConfig);
}

export async function resolveConfigPath(cwd = process.cwd()): Promise<string> {
  return path.resolve(cwd, configRelativePath);
}
