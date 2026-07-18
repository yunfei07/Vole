# Vole

Vole 是一个静态知识库优先、AI Runtime 兜底的 Playwright 测试生成 CLI。

```text
自然语言用例
→ Test Plan
→ 静态知识库 Resolver
→ 静态 Playwright 或 AI fallback
→ 执行与诊断
```

## 解析与生成规则

- 页面、元素和业务动作仍只通过 `kb scan/import` 写入知识库。
- 静态匹配成功时生成普通 Playwright locator 和 assertion。
- 元素零匹配时，点击、填写、选择和上传生成 `this.ai.act`。
- 断言目标零匹配时生成 `this.ai.assert`；其内部使用 `observe/extract`。
- 业务动作零匹配时生成 `this.ai.agent`。
- `goto` 未匹配或任何步骤 ambiguous 时，`case build` 仍立即失败。
- AI Runtime 不写入知识库，不创建动态元素、页面状态或 KB patch。

## 安装和初始化

```bash
npm install
npm run build
node dist/cli/index.js init
```

初始化会创建：

```text
.vole/
  ai-cache/
  auth/
  artifacts/
    ai/
  generated/
  kb-drafts/
  kb.sqlite
cases/
pages/
tests/generated/
```

配置模型 API Key：

```bash
export ZHIPU_API_KEY="..."
```

配置文件位于 `.vole/vole.config.json`。`ai.apiKey` 可直接配置密钥，`ai.apiKeyEnv` 可配置环境变量名；该配置文件由 `init` 加入忽略规则，不要把密钥提交到仓库。AI Runtime 使用 AI SDK v7；`structuredOutputMode: "auto"` 会在原生 JSON Schema 不兼容时自动降级。AI Agent 仍要求模型支持 OpenAI-compatible tool calling。

## 快速开始

```bash
node dist/cli/index.js auth login
node dist/cli/index.js kb scan --all --import
node dist/cli/index.js case build cases/order-approve.md --parser rules
node dist/cli/index.js run tests/generated/case-example.spec.ts
```

单页扫描和分步导入：

```bash
node dist/cli/index.js kb scan \
  --name "订单管理页面" \
  --url "/orders" \
  --out ".vole/kb-drafts/orders.json"

node dist/cli/index.js kb import .vole/kb-drafts/orders.json
```

## CLI

```text
vole init
vole auth login

vole kb scan [--name <name> --url <url> | --all] [--import]
vole kb import <draftPath>
vole kb audit [--page <name>]
vole kb list pages|elements|actions|runs

vole case compile <casePath> [--parser ai|rules]
vole case resolve <planPath>
vole case generate <resolvedPlanPath>
vole case build [casePath | --all] [--parser ai|rules]

vole run <specPath>
vole diagnose <runId|reportPath>
```

## AI Runtime

生成的 Page Object 在需要 fallback 时公开：

```ts
await this.ai.act({
  instruction: '点击提交按钮',
  action: 'click',
  target: '提交按钮'
});

await this.ai.assert({
  instruction: '确认保存成功提示可见',
  kind: 'visible',
  target: '保存成功提示'
});

await this.ai.agent({
  instruction: '完成订单审批并确认状态更新'
});
```

也支持 Stagehand 风格调用：

```ts
const actions = await this.ai.observe('找到提交按钮');
await this.ai.act(actions[0]);

const { pageText } = await this.ai.extract();
const data = await this.ai.extract(
  '提取当前订单状态',
  z.object({ status: z.string() }),
  { screenshot: true }
);

const agent = this.ai.agent({ mode: 'dom' });
await agent.execute('完成订单审批并验证结果');
```

底层使用当前 Playwright Page 的 Chromium CDP Session 合并 DOM Snapshot 与 Accessibility Tree。元素 ID 使用 `frameOrdinal-backendNodeId`；selector scope、ignored subtree、iframe 和开放 shadow DOM 均在 Snapshot 阶段处理。动作仍由 Playwright Locator 执行，保留 auto-wait、actionability check 和 trace。

Agent 使用 AI SDK `ToolLoopAgent` 和 Zod typed tools，支持非流式/流式实例、callbacks、自定义 tools、messages continuation、Zod output、usage 与 evidence。默认最大 8 步、总超时 120 秒并限制同源导航。缓存和运行产物分别位于 `.vole/ai-cache` 和 `.vole/artifacts/ai`。

关闭 `runtimeAi.enabled` 后，零匹配步骤恢复为 unresolved，静态生成行为不变。

## 测试

```bash
npm test
npm run test:runtime-ai
VOLE_LIVE_AI=1 npm run test:live-ai
```

测试覆盖 Resolver fallback、生成代码、CDP DOM/AX 合并、敏感值清理、缓存、四项 Runtime 编排、数据库迁移和原有静态路径。

更多信息：

- [使用指南](docs/usage-guide.md)
- [产品需求](docs/prd.md)
- [实施说明](docs/implementation-plan.md)
- [Demo 场景](docs/demo-scenarios.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
