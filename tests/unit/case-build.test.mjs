import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { caseBuildCommand } from '../../dist/cli/commands/case-build.js';
import { caseCompileCommand } from '../../dist/cli/commands/case-compile.js';
import { defaultConfig } from '../../dist/config/default-config.js';
import { importDraft, openKb } from '../../dist/kb/repository.js';
import { RuntimeModelClient } from '../../dist/runtime-ai/model-client.js';
import { testPlanSchema } from '../../dist/cases/test-plan-schema.js';
import { resolvePlan } from '../../dist/resolver/resolver.js';
import { generateTestFiles } from '../../dist/codegen/generator.js';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = '# 保存名称\n角色：admin\n前置条件：\n- 已登录\n目标：在设置页面保存站点名称 Vole，验证提示为保存成功';
const instructions = ['进入设置页面', '在站点名称输入框输入Vole', '点击保存按钮', '断言提示为保存成功'];
const primitives = [
  { action: 'goto', target: '设置页面' },
  { action: 'fill', target: '站点名称输入框', value: 'Vole' },
  { action: 'click', target: '保存按钮' },
  { action: 'assertText', target: '提示', value: '保存成功' }
];

async function fixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'vole-build-agent-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, '.vole'), { recursive: true });
  await mkdir(path.join(cwd, 'cases'));
  // Use the actual project dependencies and runtime declarations for generated tsc checks.
  await symlink(path.join(root, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
  await symlink(path.join(root, 'dist'), path.join(cwd, 'dist'), 'dir');
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify({
    name: 'vole', type: 'module', exports: { './runtime-ai': { types: './dist/runtime-ai/index.d.ts', import: './dist/runtime-ai/index.js' } }
  }));
  const config = { ...defaultConfig, ai: { ...defaultConfig.ai, apiKey: 'fake', maxRetries: 0 } };
  await writeFile(path.join(cwd, '.vole/vole.config.json'), JSON.stringify(config));
  await writeFile(path.join(cwd, 'cases/case.md'), source);
  const db = await openKb(path.join(cwd, config.knowledgeBase));
  try {
    importDraft(db, {
      version: 1, generatedAt: new Date().toISOString(),
      page: { name: '设置页面', url: '/settings' },
      elements: [
        { semanticName: '站点名称输入框', elementType: 'textbox', role: 'textbox', locatorPrimary: "page.getByTestId('site-name')", confidence: 1, status: 'approved' },
        { semanticName: '保存按钮', elementType: 'button', role: 'button', locatorPrimary: "page.getByTestId('save')", confidence: 1, status: 'approved' },
        { semanticName: '提示', elementType: 'text', locatorPrimary: "page.getByTestId('notice')", confidence: 1, status: 'approved' }
      ], businessActions: []
    });
  } finally { db.close(); }
  return cwd;
}

function mockModel(t, { blocked = () => false, changePlan = (plan) => plan } = {}) {
  const calls = [];
  t.mock.method(RuntimeModelClient.prototype, 'generateObject', async function (input) {
    calls.push(input);
    const value = input.purpose === 'BUILD_AGENT_ANALYSIS_FAILED'
      ? {
        goal: input.user.case.goal ?? '保存站点名称', preconditions: ['已登录'], acceptanceCriteria: ['提示为保存成功'],
        steps: instructions.map((instruction, i) => ({ instruction, kind: i === 3 ? 'assertion' : 'action', source: '原始用例和设置页面知识库' })),
        missingItems: blocked(input.user.case) ? ['缺少站点名称'] : []
      }
      : changePlan({
        name: input.user.case.name,
        steps: primitives.map((step, i) => ({ ...step, id: `step_${i}`, rawText: instructions[i] }))
      });
    return { value };
  });
  return calls;
}

async function json(cwd, relative) {
  return JSON.parse(await readFile(path.join(cwd, relative), 'utf8'));
}

test('default goal build generates validated static scripts, preserves output options, and protects existing files', async (t) => {
  const cwd = await fixture(t);
  const calls = mockModel(t);
  const options = { out: 'output/example.spec.ts', pageObjectOut: 'output/example.page.ts' };
  await caseBuildCommand('cases/case.md', options, cwd);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].user.case.sourceMarkdown, source);
  assert.equal(calls[0].user.knowledgeBase.elements.length, 3);
  assert.strictEqual(calls[0].user.knowledgeBase, calls[1].user.knowledgeBase);
  const analysis = await json(cwd, '.vole/generated/plans/保存名称.build.json');
  assert.deepEqual(calls[1].user.analysis, analysis);
  const plan = await json(cwd, '.vole/generated/plans/保存名称.plan.json');
  assert.deepEqual(plan.steps.map((step) => step.id), ['step_001', 'step_002', 'step_003', 'step_004']);
  const resolved = await json(cwd, '.vole/generated/plans/保存名称.resolved.json');
  assert.equal(resolved.summary.resolved, 3);
  assert.equal(resolved.summary.aiFallback, 1);
  const pageFile = path.join(cwd, options.pageObjectOut);
  const specFile = path.join(cwd, options.out);
  const pageSource = await readFile(pageFile, 'utf8');
  assert.match(pageSource, /\.fill\("Vole"\)/);
  assert.match(pageSource, /this\.ai\.assert/);
  assert.doesNotMatch(pageSource, /\bexpect\(/);
  const specSource = await readFile(specFile, 'utf8');
  await assert.rejects(caseBuildCommand('cases/case.md', options, cwd), /file already exists/);
  assert.equal(await readFile(pageFile, 'utf8'), pageSource);
  assert.equal(await readFile(specFile, 'utf8'), specSource);
  await caseBuildCommand('cases/case.md', { ...options, parser: 'ai', overwrite: true }, cwd);
});

test('blocked builds persist missing items without producing plans or scripts', async (t) => {
  const cwd = await fixture(t);
  const calls = mockModel(t, { blocked: () => true });
  await assert.rejects(caseBuildCommand('cases/case.md', {}, cwd), /BUILD_AGENT_BLOCKED.*\n- 缺少站点名称/);
  assert.equal(calls.length, 1);
  const analysis = await json(cwd, '.vole/generated/plans/保存名称.build.json');
  assert.deepEqual(analysis.missingItems, ['缺少站点名称']);
  assert.deepEqual(await readdir(path.join(cwd, '.vole/generated/plans')), ['保存名称.build.json']);
  await assert.rejects(readdir(path.join(cwd, 'tests/generated')), { code: 'ENOENT' });
  const db = await openKb(path.join(cwd, '.vole/kb.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS count FROM test_plans').get().count, 0); }
  finally { db.close(); }
});

test('element fallback generates validated AI runtime scripts but unresolved navigation still fails', async (t) => {
  const cwd = await fixture(t);
  let missingPage = false;
  mockModel(t, { changePlan: (plan) => ({ ...plan, steps: plan.steps.map((step, i) =>
    i === 0 && missingPage ? { ...step, target: '未知导航' } : i === 2 ? { ...step, target: '发布按钮' } : step
  ) }) });
  await caseBuildCommand('cases/case.md', {}, cwd);
  const resolved = await json(cwd, '.vole/generated/plans/保存名称.resolved.json');
  assert.equal(resolved.summary.aiFallback, 2);
  const pageName = (await readdir(path.join(cwd, 'pages')))[0];
  assert.match(await readFile(path.join(cwd, 'pages', pageName), 'utf8'), /this\.ai\.act/);
  missingPage = true;
  await assert.rejects(caseBuildCommand('cases/case.md', { overwrite: true }, cwd), /RESOLVE_FAILED/);
});

test('rules and standalone compile require steps and preserve their existing workflow', async (t) => {
  const cwd = await fixture(t);
  t.mock.method(RuntimeModelClient.prototype, 'generateObject', () => assert.fail('rules must not call the model'));
  await assert.rejects(caseBuildCommand('cases/case.md', { parser: 'rules' }, cwd), /at least one step/);
  await assert.rejects(caseCompileCommand('cases/case.md', {}, cwd), /at least one step/);
  await writeFile(path.join(cwd, 'cases/case.md'), `# 保存名称\n角色：admin\n步骤：\n${instructions.map((step) => `- ${step}`).join('\n')}`);
  await caseBuildCommand('cases/case.md', { parser: 'rules' }, cwd);
  await assert.rejects(readFile(path.join(cwd, '.vole/generated/plans/保存名称.build.json')), { code: 'ENOENT' });
  await caseCompileCommand('cases/case.md', { parser: 'rules', out: 'compiled.json' }, cwd);
  assert.equal((await json(cwd, 'compiled.json')).steps.length, 4);
});

test('batch reports blocked cases and continues with detailed-step cases', async (t) => {
  const cwd = await fixture(t);
  await writeFile(path.join(cwd, 'cases/a-blocked.md'), '# 缺少数据\n目标：保存设置并验证成功');
  await writeFile(path.join(cwd, 'cases/case.md'), `# 保存名称\n步骤：\n- ${instructions.join('，')}`);
  const calls = mockModel(t, { blocked: (parsed) => parsed.name === '缺少数据' });
  await assert.rejects(caseBuildCommand(undefined, { all: true }, cwd), /CASE_BUILD_FAILED: 1\/2 cases failed/);
  assert.equal(calls.length, 3);
  assert.equal((await readdir(path.join(cwd, 'tests/generated'))).length, 1);
  assert.equal((await json(cwd, '.vole/generated/plans/保存名称.plan.json')).steps.length, 4);
  assert.deepEqual((await json(cwd, '.vole/generated/plans/缺少数据.build.json')).missingItems, ['缺少站点名称']);
  await assert.rejects(caseBuildCommand(undefined, { all: true, out: 'x.ts' }, cwd), /only supported for single-case/);
});

test('empty element KB generates act, observe, agent and checked extract using real runtime types', async (t) => {
  const cwd = await fixture(t);
  const db = await openKb(path.join(cwd, '.vole/kb.sqlite'));
  try { db.prepare('DELETE FROM elements').run(); }
  finally { db.close(); }
  const steps = [
    { action: 'goto', target: '设置页面', rawText: '进入设置页面' },
    { action: 'observe', rawText: '观察设置页面的输入框' },
    { action: 'fill', target: '系统名称输入框', value: 'Vole', rawText: '在系统名称输入框输入 Vole' },
    { action: 'businessAction', target: '保存并检查结果', rawText: '使用 ai.agent 保存设置并确认提示' },
    { action: 'extract', rawText: '记录提示文本', fields: { notice: { description: '页面保存提示的完整文本' } } },
    { action: 'assertSemantic', target: '提示', rawText: '断言提示为保存成功', value: '保存成功' }
  ].map((step, i) => ({ ...step, id: `step_${i}` }));
  t.mock.method(RuntimeModelClient.prototype, 'generateObject', async (input) => {
    assert.equal(input.user.knowledgeBase.elements.length, 0);
    assert.equal(input.user.knowledgeBase.actions.length, 0);
    return { value: input.purpose === 'BUILD_AGENT_ANALYSIS_FAILED'
      ? { goal: '测试 AI 能力', preconditions: [], acceptanceCriteria: ['保存成功'], missingItems: [],
        steps: steps.map((step) => ({ instruction: step.rawText, kind: step.action.startsWith('assert') ? 'assertion' : 'action', source: '用例' })) }
      : { name: '保存名称', steps } };
  });
  await caseBuildCommand('cases/case.md', {}, cwd);
  const resolved = await json(cwd, '.vole/generated/plans/保存名称.resolved.json');
  assert.deepEqual(resolved.steps.map((step) => step.resolution.execution), ['static', 'ai-observe', 'ai-act', 'ai-agent', 'ai-extract', 'ai-assert']);
  assert.equal(resolved.summary.resolved, 1);
  assert.equal(resolved.summary.aiFallback, 5);
  const pageName = (await readdir(path.join(cwd, 'pages')))[0];
  const code = await readFile(path.join(cwd, 'pages', pageName), 'utf8');
  for (const method of ['observe', 'act', 'agent', 'extract']) assert.ok(code.includes(`this.ai.${method}(`));
  assert.doesNotMatch(code, /\bexpect\(/);
  assert.match(code, /this\.ai\.assert.*保存成功/);
  assert.match(code, /context\["notice"\] = extracted\["notice"\]/);
  const extractionCall = code.slice(code.indexOf('const extracted ='), code.indexOf('}));', code.indexOf('const extracted =')));
  assert.doesNotMatch(extractionCall, /保存成功/);
  assert.match(extractionCall, /页面保存提示的完整文本/);

  const disabled = resolvePlan({ name: 'AI disabled', steps: steps.slice(1) }, { pages: [], elements: [], actions: [] }, { aiFallback: false });
  assert.equal(disabled.status, 'unresolved');
  assert.equal(disabled.summary.aiFallback, 0);
});

test('extract schema requires named fields with explicit descriptions', () => {
  for (const fields of [{}, { name: { description: '', expected: '值' } }, { 'bad key': { description: '名称', expected: '值' } }]) {
    assert.equal(testPlanSchema.safeParse({ name: 'test', steps: [{ id: '1', rawText: '提取', action: 'extract', fields }] }).success, false);
  }
});

test('generated unknown clicks consume a unique observed action and never choose among ambiguous candidates', async () => {
  const kb = { pages: [], elements: [], actions: [] };
  const plan = resolvePlan({ name: '发现并执行', steps: [
    { id: '1', rawText: '点击商品查询按钮', action: 'click', target: '商品查询按钮' },
    { id: '2', rawText: '断言商品列表为收纳箱', action: 'assertText', target: '商品列表', value: '收纳箱' }
  ] }, kb, { aiFallback: true });
  const generated = generateTestFiles(plan, kb, {
    cwd: root, testDir: 'tests/generated', pageObjectDir: 'pages', baseUrl: 'http://localhost',
    storageState: '', ignoreHTTPSErrors: true, playwrightTimeoutMs: 30000, runtimeAiTimeoutMs: 30000, agentTimeoutMs: 120000
  });
  assert.doesNotMatch(generated.pageObjectSource, /\bexpect\(/);
  const compiled = ts.transpileModule(generated.pageObjectSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  for (const count of [0, 1, 2]) {
    const calls = [];
    const runtime = {
      observe: async (instruction) => {
        calls.push(['observe', instruction]);
        return Array.from({ length: count }, (_, i) => ({ method: 'click', selector: `#query${i}`, description: '查询', arguments: [] }));
      },
      act: async (input) => { calls.push(['act', input]); return { success: true }; },
      assert: async (input) => { calls.push(['assert', input]); }
    };
    const exports = {};
    new Function('require', 'exports', compiled)((name) => name === 'vole/runtime-ai' ? { createAiRuntime: () => runtime } : {}, exports);
    const flow = new exports.GeneratedCasePage({});
    await flow.step001({});
    await flow.step002({});
    assert.deepEqual(calls.map(([name]) => name), ['observe', 'act', 'assert']);
    if (count === 1) assert.equal(calls[1][1].selector, '#query0');
    else {
      assert.equal(calls[1][1].instruction, '点击商品查询按钮');
      assert.equal(calls[1][1].selector, undefined);
    }
    assert.equal(calls[2][1].kind, 'containsText');
    assert.equal(calls[2][1].expected, '收纳箱');
    runtime.act = async () => ({ success: false, message: 'action failed' });
    await assert.rejects(flow.step001({}), /action failed/);
    runtime.assert = async () => { throw new Error('AI_ASSERT_FAILED'); };
    await assert.rejects(flow.step002({}), /AI_ASSERT_FAILED/);
  }
});

test('unknown select allows the runtime to handle a custom two-step dropdown', () => {
  const kb = { pages: [], elements: [], actions: [] };
  const plan = resolvePlan({ name: '选择分类', steps: [
    { id: '1', rawText: '选择分类为数码', action: 'select', target: '分类', value: '数码' }
  ] }, kb, { aiFallback: true });
  const generated = generateTestFiles(plan, kb, {
    cwd: root, testDir: 'tests/generated', pageObjectDir: 'pages', baseUrl: 'http://localhost',
    storageState: '', ignoreHTTPSErrors: true, playwrightTimeoutMs: 30000, runtimeAiTimeoutMs: 30000, agentTimeoutMs: 120000
  });
  assert.match(generated.pageObjectSource, /this\.ai\.act.*选择分类为数码.*value: "数码"/);
  assert.doesNotMatch(generated.pageObjectSource, /action: "selectOption"/);
});

test('known assertions still require AI and example cases use ordinary business Markdown', async () => {
  const kb = { pages: [], actions: [], elements: [{ semantic_name: '提示', locator_primary: 'page.getByText("成功")' }] };
  const input = { name: '已知断言', steps: [{ id: '1', action: 'assertText', target: '提示', value: '成功', rawText: '断言提示为成功' }] };
  assert.equal(resolvePlan(input, kb, { aiFallback: true }).steps[0].resolution.execution, 'ai-assert');
  assert.equal(resolvePlan(input, kb, { aiFallback: false }).status, 'unresolved');
  for (const file of ['build-agent-settings-goal.md', 'build-agent-runtime-capabilities.md']) {
    const content = await readFile(path.join(root, 'cases', file), 'utf8');
    assert.match(content, /^# .+\n\n前置条件：\n/);
    assert.match(content, /\n步骤：\n- /);
    assert.doesNotMatch(content, /## |ai\.(?:act|agent|observe|extract|assert)|目标：|验收标准|运行说明/);
  }
});
