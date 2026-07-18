import path from 'node:path';
import { testPlanSchema } from '../../cases/test-plan-schema.js';
import { loadConfig } from '../../config/load-config.js';
import { listActions, listElements, listPages, openKb, updateResolvedPlanByName } from '../../kb/repository.js';
import { resolvePlan } from '../../resolver/resolver.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

export type CaseResolveOptions = {
  out?: string;
};

export async function caseResolveCommand(planPath: string, options: CaseResolveOptions, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const resolvedPlanPath = resolveFromCwd(cwd, planPath);
  const plan = testPlanSchema.parse(await readJsonFile<unknown>(resolvedPlanPath));
  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));

  try {
    const resolvedPlan = resolvePlan(plan, {
      pages: listPages(db),
      elements: listElements(db),
      actions: listActions(db)
    }, { aiFallback: config.runtimeAi.enabled });
    const outPath = options.out ?? defaultResolvedPlanPath(resolvedPlanPath);

    await writeJsonFile(outPath, resolvedPlan);
    updateResolvedPlanByName(db, plan.name, resolvedPlan);

    console.log(`用例：${resolvedPlan.name}`);
    console.log(`状态：${resolvedPlan.status}`);
    console.log(`已解析：${resolvedPlan.summary.resolved}/${resolvedPlan.summary.total}`);
    console.log(`AI fallback：${resolvedPlan.summary.aiFallback}`);
    console.log(`歧义：${resolvedPlan.summary.ambiguous}`);
    console.log(`未解析：${resolvedPlan.summary.unresolved}`);
    console.log(`输出文件：${path.relative(cwd, outPath)}`);

    for (const item of resolvedPlan.steps) {
      const marker = item.resolution.status === 'resolved'
        ? '✓'
        : item.resolution.status === 'ai_fallback'
          ? 'AI'
          : item.resolution.status === 'ambiguous'
            ? '?'
            : '×';
      const detail = item.resolution.matched
        ? `${item.resolution.matched.type}:${item.resolution.matched.semanticName}`
        : item.resolution.reason;
      console.log(`${marker} ${item.step.id} ${item.step.rawText} -> ${detail}`);
    }
  } finally {
    db.close();
  }
}

function defaultResolvedPlanPath(planPath: string): string {
  return planPath.replace(/\.plan\.json$/u, '.resolved.json');
}
