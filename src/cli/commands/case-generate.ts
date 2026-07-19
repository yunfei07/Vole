import path from 'node:path';
import { generateTestFiles } from '../../codegen/generator.js';
import { writeGeneratedFile } from '../../codegen/write-files.js';
import { loadConfig } from '../../config/load-config.js';
import { listActions, listElements, listPages, openKb } from '../../kb/repository.js';
import type { ResolvedPlan } from '../../resolver/types.js';
import { readJsonFile } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

export type CaseGenerateOptions = {
  out?: string;
  pageObjectOut?: string;
  overwrite?: boolean;
};

export async function caseGenerateCommand(resolvedPlanPath: string, options: CaseGenerateOptions, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const resolvedPlan = (await readJsonFile<unknown>(resolveFromCwd(cwd, resolvedPlanPath))) as ResolvedPlan;
  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));

  try {
    const generated = generateTestFiles(
      resolvedPlan,
      {
        pages: listPages(db),
        elements: listElements(db),
        actions: listActions(db)
      },
      {
        cwd,
        testDir: config.testDir,
        pageObjectDir: config.pageObjectDir,
        baseUrl: config.baseUrl,
        storageState: config.auth.storageState,
        ignoreHTTPSErrors: config.playwright.ignoreHTTPSErrors,
        playwrightTimeoutMs: config.playwright.timeout,
        runtimeAiTimeoutMs: config.runtimeAi.timeoutMs,
        agentTimeoutMs: config.runtimeAi.agent.timeoutMs,
        specOut: options.out,
        pageObjectOut: options.pageObjectOut
      }
    );

    await writeGeneratedFile(generated.pageObjectPath, generated.pageObjectSource, options.overwrite);
    await writeGeneratedFile(generated.specPath, generated.specSource, options.overwrite);

    console.log(`生成 Page Object：${path.relative(cwd, generated.pageObjectPath)}`);
    console.log(`生成 Spec：${path.relative(cwd, generated.specPath)}`);
  } finally {
    db.close();
  }
}
