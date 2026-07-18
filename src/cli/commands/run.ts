import path from 'node:path';
import { loadConfig } from '../../config/load-config.js';
import { openKb, saveRunResult } from '../../kb/repository.js';
import { runPlaywrightSpec } from '../../playwright/runner.js';
import { resolveFromCwd } from '../../utils/paths.js';

export async function runCommand(specPath: string, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const resolvedSpecPath = resolveFromCwd(cwd, specPath);
  const relativeSpecPath = path.relative(cwd, resolvedSpecPath);
  const result = await runPlaywrightSpec(cwd, relativeSpecPath, {
    artifactsDir: config.artifactsDir
  });

  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));
  try {
    const runId = saveRunResult(db, {
      specPath: relativeSpecPath,
      status: result.status,
      errorType: result.errorType,
      errorMessage: result.errorMessage,
      tracePath: result.tracePath ? path.relative(cwd, result.tracePath) : undefined,
      screenshotPath: result.screenshotPath ? path.relative(cwd, result.screenshotPath) : undefined,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt
    });

    console.log(`Run ID：${runId}`);
    console.log(`状态：${result.status}`);
    console.log(`报告：${path.relative(cwd, result.reportPath)}`);
    if (result.errorType) console.log(`错误类型：${result.errorType}`);
    if (result.tracePath) console.log(`Trace：${path.relative(cwd, result.tracePath)}`);
    if (result.screenshotPath) console.log(`Screenshot：${path.relative(cwd, result.screenshotPath)}`);
  } finally {
    db.close();
  }

  if (result.status !== 'passed') {
    process.exitCode = result.exitCode;
  }
}
