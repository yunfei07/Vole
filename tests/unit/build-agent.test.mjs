import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAgent } from '../../dist/ai/build-agent.js';
import { parseMarkdownCaseContent } from '../../dist/cases/markdown-parser.js';
import { defaultConfig } from '../../dist/config/default-config.js';
import { RuntimeModelClient } from '../../dist/runtime-ai/model-client.js';

const config = {
  ...defaultConfig,
  ai: { ...defaultConfig.ai, apiKey: 'fake', model: 'build-model', maxRetries: 0 },
  runtimeAi: { ...defaultConfig.runtimeAi, model: 'runtime-model' }
};
const kb = {
  pages: [{ name: '设置页面', url: '/settings', title: '设置', description: '系统设置' }],
  elements: [{ semantic_name: '保存按钮', page_name: '设置页面', element_type: 'button', role: 'button', visible_text: '保存' }],
  actions: [{ name: '保存设置', page_name: '设置页面', description: '保存设置', input_schema_json: '{"name":"string"}', steps_json: '[{"action":"click","target":"保存按钮"}]' }]
};
const markdown = '# 保存设置\n角色：admin\n前置条件：\n- 已登录\n目标：保存站点名称为 Vole，验证提示为保存成功\n步骤：\n- 进入设置页面，输入 Vole 并保存，验证提示为保存成功';
const parsedCase = parseMarkdownCaseContent(markdown);
function analysis() {
  return {
    goal: '保存站点名称并验证结果',
    preconditions: ['已登录'],
    acceptanceCriteria: ['提示为保存成功'],
    missingItems: [],
    steps: [
      { instruction: '进入设置页面', kind: 'action', source: '用例步骤、知识库设置页面' },
      { instruction: '在站点名称输入框输入 Vole', kind: 'action', source: '目标中的 Vole' },
      { instruction: '点击保存按钮', kind: 'action', source: '用例步骤' },
      { instruction: '断言提示为保存成功', kind: 'assertion', source: '用例目标' }
    ]
  };
}
function compiled() {
  return {
    name: '模型修改的名称', role: 'other', preconditions: ['模型添加的前置条件'],
    steps: [
      { action: 'goto', target: '设置页面' },
      { action: 'fill', target: '站点名称输入框', value: 'Vole' },
      { action: 'click', target: '保存按钮' },
      { action: 'assertText', target: '提示', value: '保存成功' }
    ].map((step) => ({ ...step, id: 'model-id', rawText: 'model-text' }))
  };
}

test('goal parsing is opt-in and supports inline, multiline, and heading sections', () => {
  for (const goal of ['目标：验证提示可见', '目标：\n验证提示可见', '## 目标\n验证提示可见']) {
    const source = `# 标题\n${goal}\n## 前置条件\n- 已登录\n## 说明\n不是目标的一部分`;
    const parsed = parseMarkdownCaseContent(source, { allowGoalOnly: true });
    assert.equal(parsed.goal, '验证提示可见');
    assert.deepEqual(parsed.steps, []);
    assert.deepEqual(parsed.preconditions, ['已登录']);
    assert.equal(parsed.sourceMarkdown, source);
    assert.throws(() => parseMarkdownCaseContent(source), /at least one step/);
  }
  assert.throws(() => parseMarkdownCaseContent('# 空\n目标：', { allowGoalOnly: true }), /goal or at least one step/);
  assert.throws(() => parseMarkdownCaseContent('目标：检查', { allowGoalOnly: true }), /level-1 title/);
  assert.equal(parsedCase.steps.length, 1);
  assert.equal(parsedCase.role, 'admin');
});

test('two-stage build uses ai.model and passes full source, KB semantics, and saved analysis to compilation', async () => {
  const requests = [];
  let saved;
  const client = new RuntimeModelClient(config, {
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      assert.equal(input.case.sourceMarkdown, markdown);
      assert.equal(input.knowledgeBase.elements[0].page, '设置页面');
      assert.equal(input.knowledgeBase.actions[0].inputs, kb.actions[0].input_schema_json);
      assert.equal(request.model, 'build-model');
      if (requests.length === 2) assert.deepEqual(input.analysis, saved);
      return new Response(JSON.stringify({
        id: 'mock', object: 'chat.completion', created: 1, model: 'build-model',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(requests.length === 1 ? analysis() : compiled()) }, finish_reason: 'stop' }]
      }), { headers: { 'Content-Type': 'application/json' } });
    }
  });
  const plan = await buildAgent(config, parsedCase, kb, { client, onAnalysis: async (value) => { saved = value; } });
  assert.equal(requests.length, 2);
  assert.equal(plan.name, parsedCase.name);
  assert.equal(plan.role, 'admin');
  assert.deepEqual(plan.preconditions, ['已登录']);
  assert.equal(plan.steps.length, 4);
  assert.deepEqual(plan.steps.map((step) => step.id), ['step_001', 'step_002', 'step_003', 'step_004']);
  assert.deepEqual(plan.steps.map((step) => step.rawText), saved.steps.map((step) => step.instruction));
  assert.equal(plan.steps[1].value, 'Vole');
  assert.equal(plan.steps[3].value, '保存成功');
});

test('missing information or an absent assertion is persisted and blocks the second call', async () => {
  for (const value of [
    { ...analysis(), missingItems: ['缺少订单编号'] },
    { ...analysis(), steps: [] },
    { ...analysis(), acceptanceCriteria: [] },
    { ...analysis(), steps: analysis().steps.slice(0, 3) }
  ]) {
    let saved;
    let calls = 0;
    await assert.rejects(buildAgent(config, parsedCase, kb, {
      client: { generateObject: async () => { calls++; return { value }; } },
      onAnalysis: async (result) => { saved = result; }
    }), /BUILD_AGENT_BLOCKED/);
    assert.equal(calls, 1);
    assert.ok(saved.missingItems.length > 0);
  }
});

test('invalid outputs, omitted steps, and changed action/assertion kinds fail explicitly', async () => {
  for (const bad of [
    { ...compiled(), steps: compiled().steps.slice(1) },
    { ...compiled(), steps: compiled().steps.map((step, i) => i === 3 ? { ...step, action: 'click' } : step) },
    { ...compiled(), steps: compiled().steps.map((step, i) => i === 1 ? { ...step, action: 'assertText' } : step) },
    { ...compiled(), steps: [{ action: 'unsupported' }] }
  ]) {
    let calls = 0;
    await assert.rejects(buildAgent(config, parsedCase, kb, {
      client: { generateObject: async () => ({ value: ++calls === 1 ? analysis() : bad }) },
      onAnalysis: async () => {}
    }));
    assert.equal(calls, 2);
  }
  await assert.rejects(buildAgent(config, parsedCase, kb, {
    client: { generateObject: async () => ({ value: { goal: '' } }) },
    onAnalysis: async () => assert.fail('invalid analysis cannot be saved')
  }));
});

test('model failures retain stage-one analysis and respect configured timeout', async () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    let saved = false;
    await assert.rejects(buildAgent(config, parsedCase, kb, {
      client: { generateObject: async (input) => {
        assert.equal(input.timeoutMs, config.ai.timeoutMs);
        assert.equal(input.model, config.ai.model);
        if (++calls === failAt) throw new Error('AI_RUNTIME_TIMEOUT: simulated timeout');
        return { value: analysis() };
      } },
      onAnalysis: async () => { saved = true; }
    }), /AI_RUNTIME_TIMEOUT/);
    assert.equal(calls, failAt);
    assert.equal(saved, failAt === 2);
  }
});

test('analysis persistence errors prevent compilation', async () => {
  let calls = 0;
  await assert.rejects(buildAgent(config, parsedCase, kb, {
    client: { generateObject: async () => { calls++; return { value: analysis() }; } },
    onAnalysis: async () => { throw new Error('disk full'); }
  }), /disk full/);
  assert.equal(calls, 1);
});
