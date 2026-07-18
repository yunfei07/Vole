import path from 'node:path';
import { readJsonFile } from '../utils/fs.js';
import { aiPwConfigSchema, type AiPwConfig } from './schema.js';

export async function loadConfig(cwd = process.cwd()): Promise<AiPwConfig> {
  const configPath = path.resolve(cwd, 'ai-pw.config.json');
  const rawConfig = await readJsonFile<unknown>(configPath);
  return aiPwConfigSchema.parse(rawConfig);
}
