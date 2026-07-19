import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { compileCaseWithAi } from '../../ai/intent-parser.js';
import { parseMarkdownCase } from '../../cases/markdown-parser.js';
import { compileCaseWithRules } from '../../cases/rule-compiler.js';
import type { TestPlan } from '../../cases/test-plan-schema.js';
import { generateTestFiles } from '../../codegen/generator.js';
import { validateGeneratedTypescript } from '../../codegen/validator.js';
import { writeGeneratedFile } from '../../codegen/write-files.js';
import { loadConfig } from '../../config/load-config.js';
import {
  listActions,
  listElements,
  listPages,
  openKb,
  saveTestPlan,
  updateResolvedPlanByName
} from '../../kb/repository.js';
import { resolvePlan } from '../../resolver/resolver.js';
import type { ResolvedPlan } from '../../resolver/types.js';
import { ensureDir, writeJsonFile } from '../../utils/fs.js';
import { slugify } from '../../utils/id.js';
import { resolveFromCwd } from '../../utils/paths.js';

export type CaseBuildOptions = {
  parser?: 'ai' | 'rules';
  overwrite?: boolean;
  out?: string;
  pageObjectOut?: string;
  all?: boolean;
};

export async function caseBuildCommand(casePath: string | undefined, options: CaseBuildOptions, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  if (options.all) {
    if (casePath) {
      throw new Error('CASE_BUILD_FAILED: pass either --all or a case path, not both');
    }

    if (options.out || options.pageObjectOut) {
      throw new Error('CASE_BUILD_FAILED: --out and --page-object-out are only supported for single-case build');
    }

    const casePaths = await listConfiguredCases(cwd, config.caseDir);
    if (casePaths.length === 0) {
      throw new Error(`CASE_BUILD_FAILED: no markdown cases found in ${config.caseDir}`);
    }

    await buildManyCases(casePaths, options, cwd);
    return;
  }

  if (!casePath) {
    throw new Error('CASE_BUILD_FAILED: pass a case path or --all');
  }

  await buildOneCase(casePath, options, cwd, config);
}

async function buildManyCases(casePaths: string[], options: CaseBuildOptions, cwd: string): Promise<void> {
  const failures: Array<{ casePath: string; message: string }> = [];
  console.log(`批量构建用例：${casePaths.length} 个`);

  for (const [index, casePath] of casePaths.entries()) {
    console.log('');
    console.log(`[${index + 1}/${casePaths.length}] ${path.relative(cwd, casePath)}`);

    try {
      const config = await loadConfig(cwd);
      await buildOneCase(casePath, options, cwd, config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ casePath, message });
      console.error(`构建失败：${message}`);
    }
  }

  const passed = casePaths.length - failures.length;
  console.log('');
  console.log(`批量构建完成：成功 ${passed}，失败 ${failures.length}`);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`- ${path.relative(cwd, failure.casePath)}: ${failure.message}`);
    }
    throw new Error(`CASE_BUILD_FAILED: ${failures.length}/${casePaths.length} cases failed`);
  }
}

async function buildOneCase(
  casePath: string,
  options: CaseBuildOptions,
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  const resolvedCasePath = resolveFromCwd(cwd, casePath);
  const parsedCase = await parseMarkdownCase(resolvedCasePath);
  const parser = options.parser ?? 'ai';
  const plan = await compile(parser, config, parsedCase);
  const planPath = path.resolve(cwd, '.vole/generated/plans', `${slugify(plan.name) || 'case'}.plan.json`);
  const resolvedPlanPath = planPath.replace(/\.plan\.json$/u, '.resolved.json');

  await ensureDir(path.dirname(planPath));
  await writeJsonFile(planPath, plan);

  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));
  try {
    const planId = saveTestPlan(db, {
      name: plan.name,
      sourceFile: path.relative(cwd, resolvedCasePath),
      plan
    });

    const resolvedPlan = resolvePlanWithCurrentKb(db, plan, config.runtimeAi.enabled);
    await writeJsonFile(resolvedPlanPath, resolvedPlan);
    updateResolvedPlanByName(db, plan.name, resolvedPlan);

    if (resolvedPlan.status !== 'resolved') {
      throw unresolvedPlanError(resolvedPlan);
    }

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
    await validateGeneratedTypescript(cwd, [generated.pageObjectPath, generated.specPath]);

    console.log(`用例：${plan.name}`);
    console.log(`解析器：${parser}`);
    console.log(`计划 ID：${planId}`);
    console.log(`计划文件：${path.relative(cwd, planPath)}`);
    console.log(`Resolved Plan：${path.relative(cwd, resolvedPlanPath)}`);
    console.log(
      `解析状态：${resolvedPlan.status} ` +
      `(静态 ${resolvedPlan.summary.resolved}，AI fallback ${resolvedPlan.summary.aiFallback}，总计 ${resolvedPlan.summary.total})`
    );
    console.log(`生成 Page Object：${path.relative(cwd, generated.pageObjectPath)}`);
    console.log(`生成 Spec：${path.relative(cwd, generated.specPath)}`);
    console.log('TypeScript 校验：通过');
  } finally {
    db.close();
  }
}

async function listConfiguredCases(cwd: string, caseDir: string): Promise<string[]> {
  const resolvedCaseDir = resolveFromCwd(cwd, caseDir);
  const entries = await readdir(resolvedCaseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(resolvedCaseDir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

async function compile(
  parser: 'ai' | 'rules',
  config: Awaited<ReturnType<typeof loadConfig>>,
  parsedCase: Parameters<typeof compileCaseWithRules>[0]
): Promise<TestPlan> {
  if (parser === 'rules') {
    return compileCaseWithRules(parsedCase);
  }

  return compileCaseWithAi(config, parsedCase);
}

function resolvePlanWithCurrentKb(
  db: Awaited<ReturnType<typeof openKb>>,
  plan: TestPlan,
  aiFallback: boolean
): ResolvedPlan {
  return resolvePlan(plan, {
    pages: listPages(db),
    elements: listElements(db),
    actions: listActions(db)
  }, { aiFallback });
}

function unresolvedPlanError(plan: ResolvedPlan): Error {
  const unresolved = plan.steps
    .filter((item) => item.resolution.status === 'unresolved' || item.resolution.status === 'ambiguous')
    .map((item) => `- ${item.step.id} [${item.resolution.status}] ${item.step.rawText}`);
  return new Error([
    `RESOLVE_FAILED: plan is ${plan.status} ` +
      `(${plan.summary.resolved} static + ${plan.summary.aiFallback} AI fallback / ${plan.summary.total}).`,
    ...unresolved,
    'Update the static knowledge base with "vole kb scan" and "vole kb import", then rerun case build.'
  ].join('\n'));
}
