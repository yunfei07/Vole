import path from 'node:path';
import { compileCaseWithAi } from '../../ai/intent-parser.js';
import { compileCaseWithRules } from '../../cases/rule-compiler.js';
import { parseMarkdownCase } from '../../cases/markdown-parser.js';
import type { TestPlan } from '../../cases/test-plan-schema.js';
import { loadConfig } from '../../config/load-config.js';
import { openKb, saveTestPlan } from '../../kb/repository.js';
import { ensureDir, writeJsonFile } from '../../utils/fs.js';
import { slugify } from '../../utils/id.js';
import { resolveFromCwd } from '../../utils/paths.js';
import { getLogger } from '../../logging/context.js';

export type CaseCompileOptions = {
  parser?: 'ai' | 'rules';
  out?: string;
};

export async function caseCompileCommand(casePath: string, options: CaseCompileOptions, cwd = process.cwd()): Promise<void> {
  const startedAt = Date.now();
  const config = await loadConfig(cwd);
  const resolvedCasePath = resolveFromCwd(cwd, casePath);
  const parsedCase = await parseMarkdownCase(resolvedCasePath);
  const parser = options.parser ?? 'ai';
  const plan = await compile(parser, config, parsedCase);
  const outPath = options.out
    ? resolveFromCwd(cwd, options.out)
    : path.resolve(cwd, '.vole/generated/plans', `${slugify(parsedCase.name) || 'case'}.plan.json`);

  await ensureDir(path.dirname(outPath));
  await writeJsonFile(outPath, plan);

  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));
  try {
    const planId = saveTestPlan(db, {
      name: plan.name,
      sourceFile: path.relative(cwd, resolvedCasePath),
      plan
    });
    getLogger().child({ component: 'case-compile' }).info('case.compile_completed', {
      parser,
      planId,
      stepCount: plan.steps.length,
      planPath: path.relative(cwd, outPath),
      durationMs: Date.now() - startedAt
    });

    console.log(`用例：${plan.name}`);
    console.log(`解析器：${parser}`);
    console.log(`步骤：${plan.steps.length} 个`);
    console.log(`计划 ID：${planId}`);
    console.log(`计划文件：${path.relative(cwd, outPath)}`);
  } finally {
    db.close();
  }
}

async function compile(parser: 'ai' | 'rules', config: Awaited<ReturnType<typeof loadConfig>>, parsedCase: Parameters<typeof compileCaseWithRules>[0]): Promise<TestPlan> {
  if (parser === 'rules') {
    return compileCaseWithRules(parsedCase);
  }

  return compileCaseWithAi(config, parsedCase);
}
