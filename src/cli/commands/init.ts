import path from 'node:path';
import { defaultConfig } from '../../config/default-config.js';
import { initializeDatabase } from '../../kb/db.js';
import { ensureDir, writeFileIfMissing, writeJsonFile } from '../../utils/fs.js';
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

  const configPath = path.resolve(cwd, 'ai-pw.config.json');
  await writeFileIfMissing(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);

  const gitignorePath = path.resolve(cwd, '.gitignore');
  const createdGitignore = await writeFileIfMissing(gitignorePath, `${gitignoreEntries.join('\n')}\n`);
  if (!createdGitignore) {
    // Keep this simple for MVP: do not rewrite user-managed .gitignore files.
  }

  await initializeDatabase(resolveFromCwd(cwd, defaultConfig.knowledgeBase));
  await writeJsonFile(path.resolve(cwd, '.ai-pw/generated/plans/.keep.json'), { createdBy: 'ai-pw init' });

  console.log('Initialized AI Playwright CLI project.');
  console.log(`Config: ${configPath}`);
  console.log(`Knowledge base: ${path.resolve(cwd, defaultConfig.knowledgeBase)}`);
}
