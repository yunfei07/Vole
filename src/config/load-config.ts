import path from 'node:path';
import { pathExists, readJsonFile } from '../utils/fs.js';
import { aiPwConfigSchema, type AiPwConfig } from './schema.js';

export const configRelativePath = '.ai-pw/ai-pw.config.json';
export const legacyConfigRelativePath = 'ai-pw.config.json';

export async function loadConfig(cwd = process.cwd()): Promise<AiPwConfig> {
  const configPath = await resolveConfigPath(cwd);
  const rawConfig = await readJsonFile<unknown>(configPath);
  return aiPwConfigSchema.parse(rawConfig);
}

export async function resolveConfigPath(cwd = process.cwd()): Promise<string> {
  const configPath = path.resolve(cwd, configRelativePath);
  if (await pathExists(configPath)) {
    return configPath;
  }

  const legacyConfigPath = path.resolve(cwd, legacyConfigRelativePath);
  return await pathExists(legacyConfigPath) ? legacyConfigPath : configPath;
}
