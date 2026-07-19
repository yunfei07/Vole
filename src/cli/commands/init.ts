import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configRelativePath, loadConfig } from '../../config/load-config.js';
import { defaultConfig } from '../../config/default-config.js';
import { initializeDatabase } from '../../kb/db.js';
import { ensureDir, pathExists, writeFileIfMissing, writeJsonFile } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

const projectDirs = [
  '.vole/auth',
  '.vole/artifacts/screenshots',
  '.vole/artifacts/traces',
  '.vole/artifacts/snapshots',
  '.vole/artifacts/results',
  '.vole/artifacts/ai',
  '.vole/ai-cache',
  '.vole/generated/plans',
  '.vole/generated/specs',
  '.vole/kb-drafts',
  'cases',
  'pages',
  'tests/generated',
  'fixtures'
];

const gitignoreEntries = [
  '.vole/vole.config.json',
  '.vole/auth/',
  '.vole/artifacts/',
  '.vole/ai-cache/',
  '.vole/kb-drafts/',
  '.vole/kb.sqlite',
  '.vole/generated/',
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
  await writeFileIfMissing(configPath, `${JSON.stringify(defaultConfig, null, 2)}\n`);

  const config = await loadConfig(cwd);
  const playwrightConfigPath = path.resolve(cwd, 'playwright.config.ts');
  await writeFileIfMissing(playwrightConfigPath, renderPlaywrightConfig(config));
  await ensureGitignoreEntries(path.resolve(cwd, '.gitignore'));
  await initializeDatabase(resolveFromCwd(cwd, config.knowledgeBase));
  await writeJsonFile(path.resolve(cwd, '.vole/generated/plans/.keep.json'), { createdBy: 'vole init' });

  console.log('Initialized Vole CLI project.');
  console.log(`Config: ${configPath}`);
  console.log(`Playwright config: ${playwrightConfigPath}`);
  console.log(`Knowledge base: ${resolveFromCwd(cwd, config.knowledgeBase)}`);
}

function renderPlaywrightConfig(config: Awaited<ReturnType<typeof loadConfig>>): string {
  return `import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: ${JSON.stringify(config.testDir)},
  testMatch: '**/*.spec.ts',
  timeout: ${config.playwright.timeout},
  outputDir: '.vole/artifacts/results',
  use: {
    ignoreHTTPSErrors: ${config.playwright.ignoreHTTPSErrors},
    trace: ${JSON.stringify(config.playwright.trace)}
  }
});
`;
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
    return ![...existing].some((pattern) => pattern.endsWith('/') && entry.startsWith(pattern));
  });
  if (missing.length === 0) {
    return;
  }

  const separator = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await writeFile(gitignorePath, `${current}${separator}${missing.join('\n')}\n`, 'utf8');
}
