import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from '../dist/config/load-config.js';
import { importDraft, openKb } from '../dist/kb/repository.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cwd = path.join(root, '.vole/build-agent-runtime-smoke');
const config = await loadConfig(root);
await mkdir(path.join(cwd, '.vole'), { recursive: true });
await writeFile(path.join(cwd, '.vole/vole.config.json'), JSON.stringify({
  ...config,
  knowledgeBase: '.vole/kb.sqlite',
  testDir: 'tests/generated',
  pageObjectDir: 'pages',
  auth: { ...config.auth, storageState: path.resolve(root, config.auth.storageState) },
  runtimeAi: { ...config.runtimeAi, enabled: true },
  playwright: { ...config.playwright, headless: true }
}, null, 2), { mode: 0o600 });

const db = await openKb(path.join(cwd, '.vole/kb.sqlite'));
try {
  // Refuse to change a fixture that someone has populated with real knowledge.
  const elements = db.prepare('SELECT COUNT(*) AS count FROM elements').get().count;
  const actions = db.prepare('SELECT COUNT(*) AS count FROM business_actions').get().count;
  if (elements || actions) throw new Error('Smoke fixture must have zero elements and business actions');
  importDraft(db, {
    version: 1, generatedAt: new Date().toISOString(),
    page: { name: '商品管理页面', url: '/products' }, elements: [], businessActions: []
  });
} finally { db.close(); }

await writeFile(path.join(cwd, 'playwright.config.ts'), [
  "import { defineConfig } from '@playwright/test';",
  "export default defineConfig({ testDir: './tests/generated', use: { headless: true, trace: 'retain-on-failure' } });",
  ''
].join('\n'));

console.log(`独立构建目录：${cwd}`);
console.log('知识库：仅商品管理页面，0 个元素，0 个业务动作');
const child = spawn(process.execPath, [
  path.join(root, 'dist/cli/index.js'), 'case', 'build',
  path.join(root, 'cases/build-agent-runtime-capabilities.md'), '--overwrite'
], { cwd, stdio: 'inherit' });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
