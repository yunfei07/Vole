import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  configRelativePath,
  legacyConfigRelativePath,
  loadConfig
} from '../../config/load-config.js';
import { defaultConfig } from '../../config/default-config.js';
import { initializeDatabase } from '../../kb/db.js';
import { ensureDir, pathExists, writeFileIfMissing, writeJsonFile } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

const projectDirs = [
  '.ai-pw/auth',
  '.ai-pw/artifacts/screenshots',
  '.ai-pw/artifacts/traces',
  '.ai-pw/artifacts/snapshots',
  '.ai-pw/artifacts/results',
  '.ai-pw/artifacts/ai',
  '.ai-pw/ai-cache',
  '.ai-pw/generated/plans',
  '.ai-pw/generated/specs',
  '.ai-pw/kb-drafts',
  'cases',
  'pages',
  'tests/generated',
  'fixtures'
];

const gitignoreEntries = [
  '.ai-pw/ai-pw.config.json',
  '.ai-pw/auth/',
  '.ai-pw/artifacts/',
  '.ai-pw/ai-cache/',
  '.ai-pw/kb-drafts/',
  '.ai-pw/kb.sqlite',
  '.ai-pw/generated/',
  'tests/generated/',
  'pages/',
  'test-results/',
  'playwright-report/'
];

export async function initCommand(cwd = process.cwd()): Promise<void> {
  for (const dir of projectDirs) {
    await ensureDir(path.resolve(cwd, dir));
  }

  const configPath = path.resolve(cwd, configRelativePath);
  const legacyConfigPath = path.resolve(cwd, legacyConfigRelativePath);
  if (!(await pathExists(configPath))) {
    const configContent = await pathExists(legacyConfigPath)
      ? await readFile(legacyConfigPath, 'utf8')
      : `${JSON.stringify(defaultConfig, null, 2)}\n`;
    await writeFileIfMissing(configPath, configContent);
  }

  await ensureGitignoreEntries(path.resolve(cwd, '.gitignore'));

  const config = await loadConfig(cwd);
  await initializeDatabase(resolveFromCwd(cwd, config.knowledgeBase));
  await writeJsonFile(path.resolve(cwd, '.ai-pw/generated/plans/.keep.json'), { createdBy: 'ai-pw init' });

  console.log('Initialized AI Playwright CLI project.');
  console.log(`Config: ${configPath}`);
  console.log(`Knowledge base: ${resolveFromCwd(cwd, config.knowledgeBase)}`);
}

async function ensureGitignoreEntries(gitignorePath: string): Promise<void> {
  if (!(await pathExists(gitignorePath))) {
    await writeFileIfMissing(gitignorePath, `${gitignoreEntries.join('\n')}\n`);
    return;
  }

  const current = await readFile(gitignorePath, 'utf8');
  const existing = new Set(current.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean));
  const missing = gitignoreEntries.filter((entry) => {
    if (existing.has(entry)) {
      return false;
    }
    return !(entry.startsWith('.ai-pw/') && existing.has('.ai-pw/'));
  });
  if (missing.length === 0) {
    return;
  }

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${current}${separator}${missing.join('\n')}\n`, 'utf8');
}
