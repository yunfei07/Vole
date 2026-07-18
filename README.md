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
.ai-pw/
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
export OPENAI_API_KEY="..."
```

`ai-pw.config.json` 中的 `ai.apiKeyEnv` 推荐使用环境变量名，不要把密钥值提交到仓库。旧配置中的直接值暂时兼容。AI Agent 要求模型支持 OpenAI-compatible tool calling；四项 Runtime 能力均要求可靠的结构化 JSON 输出。

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
  --out ".ai-pw/kb-drafts/orders.json"

node dist/cli/index.js kb import .ai-pw/kb-drafts/orders.json
```

## CLI

```text
ai-pw init
ai-pw auth login

ai-pw kb scan [--name <name> --url <url> | --all] [--import]
ai-pw kb import <draftPath>
ai-pw kb audit [--page <name>]
ai-pw kb list pages|elements|actions|runs

ai-pw case compile <casePath> [--parser ai|rules]
ai-pw case resolve <planPath>
ai-pw case generate <resolvedPlanPath>
ai-pw case build [casePath | --all] [--parser ai|rules]

ai-pw run <specPath>
ai-pw diagnose <runId|reportPath>
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

底层使用当前 Playwright Page 的 Chromium CDP Session 合并 DOM Snapshot 与 Accessibility Tree。CDP 负责感知页面，动作仍由 Playwright Locator 执行，因而保留 auto-wait、actionability check 和 trace。

Agent 是有界 DOM 工具循环，默认最大 8 步、总超时 120 秒并限制同源导航。缓存和运行产物分别位于 `.ai-pw/ai-cache` 和 `.ai-pw/artifacts/ai`。

关闭 `runtimeAi.enabled` 后，零匹配步骤恢复为 unresolved，静态生成行为不变。

## 测试

```bash
npm test
```

测试覆盖 Resolver fallback、生成代码、CDP DOM/AX 合并、敏感值清理、缓存、四项 Runtime 编排、数据库迁移和原有静态路径。

更多信息：

- [使用指南](docs/usage-guide.md)
- [产品需求](docs/prd.md)
- [实施说明](docs/implementation-plan.md)
- [Demo 场景](docs/demo-scenarios.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
