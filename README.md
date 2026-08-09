# Vole

Vole 把中文 Markdown 测试用例编译成可审查、可执行的 Playwright E2E 测试。它先从 SQLite 静态知识库中解析页面、元素和业务动作，静态信息不足时再交给 AI Runtime（AI 运行时）处理。

```text
Markdown 测试用例
        ↓
Test Plan
        ↓
静态知识库解析
        ↓
Playwright 代码生成
        ↓
执行、产物与诊断
```

静态匹配始终优先。AI Runtime 不会把运行时发现写回知识库，也不会创建动态元素、页面状态或知识库补丁。

## Vole 能做什么

- 扫描页面并生成可编辑的知识库草稿，确认后再导入 SQLite。
- 把 Markdown 用例编译为结构化 Test Plan，再生成 Page Object 和 Playwright spec。
- 对静态匹配失败或存在歧义的元素、断言和业务动作启用 AI 兜底。
- 直接执行单个 AI 浏览器动作，或让 Agent 完成多步任务并验证结果。
- 保存 Playwright 报告、trace、截图、AI 运行产物和结构化 JSONL 日志。
- 使用同一个 `invocationId` 关联 CLI、Playwright worker、知识库和模型调用。

## 环境要求

- Node.js 22，项目测试和类型定义以 Node.js 22 为基准。
- npm。
- Playwright 支持的 Chromium。
- 使用 AI 功能时，需要 OpenAI-compatible 模型接口和 API Key。

切换 Node.js 版本后，如果 SQLite 原生模块出现 ABI 不匹配，可重新编译：

```bash
npm rebuild better-sqlite3
```

## 安装与初始化

```bash
npm install
npx playwright install chromium
npm run build
node dist/cli/index.js init
```

`init` 会创建项目配置、知识库、Playwright 配置和运行目录。已有文件不会被覆盖。

```text
.vole/
  vole.config.json
  kb.sqlite
  kb-drafts/
  generated/
  auth/
  ai-cache/
  artifacts/
    ai/
    results/
  logs/
cases/
pages/
tests/generated/
playwright.config.ts
```

主配置位于 `.vole/vole.config.json`。初始化后至少需要检查这些内容：

- `baseUrl`：被测应用地址。
- `scanPages`：批量扫描的页面名称和 URL。
- `auth`：登录页面、账号、密码、selector 和认证状态路径。
- `ai`：模型接口、模型名和 API Key 来源。
- `runtimeAi`：AI Runtime、缓存、自愈、超时和 Agent 限制。
- `playwright`、`pageReady`：浏览器与页面就绪策略。
- `logging`：日志级别、目录、保留时间和分片大小。

默认配置从 `OPENAI_API_KEY` 读取密钥：

```bash
export OPENAI_API_KEY="..."
```

其他 OpenAI-compatible 服务需要同步修改 `ai.baseURL`、`ai.apiKeyEnv` 和 `ai.model`。`structuredOutputMode: "auto"` 会优先尝试原生结构化输出，不兼容时改用 prompt 模式。Agent 使用 tool calling，所选模型必须支持工具调用。

## 快速开始

下面的命令都使用构建后的 CLI。安装为本地命令后，也可以把 `node dist/cli/index.js` 替换为 `vole`。

### 1. 保存登录状态

需要认证的应用先执行：

```bash
node dist/cli/index.js auth login
```

认证状态保存在 `auth.storageState` 指定的文件中。公开页面可以跳过这一步。

### 2. 建立静态知识库

按 `scanPages` 扫描并直接导入：

```bash
node dist/cli/index.js kb scan --all --import
```

生产项目更适合先检查草稿，再单独导入：

```bash
node dist/cli/index.js kb scan \
  --name "订单管理页面" \
  --url "/orders" \
  --out ".vole/kb-drafts/orders.json"

node dist/cli/index.js kb import .vole/kb-drafts/orders.json
node dist/cli/index.js kb audit --page "订单管理页面"
```

可用下面的命令查看当前数据：

```bash
node dist/cli/index.js kb list pages
node dist/cli/index.js kb list elements --page "订单管理页面"
node dist/cli/index.js kb list actions
```

### 3. 编写测试用例

在 `cases/` 下创建 Markdown 文件：

```markdown
# 订单审批通过

前置条件：
- 存在订单编号 ORD-001，状态为待审批

步骤：
- 进入订单管理页面
- 搜索订单编号 ORD-001
- 点击审批订单按钮
- 点击通过按钮
- 断言订单状态为已通过
```

一级标题是用例名称，`角色：` 为可选字段，`前置条件：` 和 `步骤：` 使用列表。用例至少需要一个步骤。

### 4. 构建用例

```bash
node dist/cli/index.js case build cases/order-approve.md --parser rules
```

`case build` 会依次完成编译、知识库解析、代码生成和 TypeScript 校验，并在终端打印生成的 Page Object 与 spec 路径。批量构建使用：

```bash
node dist/cli/index.js case build --all --parser rules
```

需要查看中间结果时，可以分步运行：

```bash
node dist/cli/index.js case compile cases/order-approve.md --parser rules
node dist/cli/index.js case resolve .vole/generated/plans/订单审批通过.plan.json
node dist/cli/index.js case generate .vole/generated/plans/订单审批通过.resolved.json
```

`--parser rules` 使用内置规则，结果稳定且不调用模型；`--parser ai` 使用模型把自然语言编译为 Test Plan。

### 5. 执行与诊断

使用 `case build` 打印的 spec 路径执行测试：

```bash
node dist/cli/index.js run tests/generated/case-example.spec.ts
node dist/cli/index.js kb list runs
node dist/cli/index.js diagnose <run-id>
```

`run` 会保存 Playwright JSON 报告，并把运行状态、错误分类、trace 和截图路径写入知识库。`diagnose` 既接受 run ID，也接受 Playwright JSON 报告路径。

## 静态解析与 AI 兜底

解析器（Resolver）会按当前页面范围匹配知识库记录，并过滤低置信度或类型不兼容的候选项。

| 结果 | `runtimeAi.enabled: true` | `runtimeAi.enabled: false` |
| --- | --- | --- |
| 页面、元素或业务动作唯一匹配 | 生成静态 Playwright | 生成静态 Playwright |
| 元素没有匹配或候选歧义 | 生成 `ai-act` 或 `ai-assert` | `unresolved` 或 `ambiguous`，构建失败 |
| 业务动作没有匹配或候选歧义 | 生成 `ai-agent` | `unresolved` 或 `ambiguous`，构建失败 |
| 页面导航没有匹配或候选歧义 | 构建失败 | 构建失败 |

静态路径生成普通 Playwright locator 和 assertion。AI 兜底只进入生成的测试代码，不修改知识库。

## 直接使用 AI Runtime

CLI 提供单动作和多步骤两种入口：

```bash
node dist/cli/index.js act "点击查询按钮" --url /products
node dist/cli/index.js agent \
  "清除所有筛选条件并确认显示全部商品" \
  --url /products \
  --max-steps 12
```

也可以从 `vole/runtime-ai` 直接创建 Runtime：

```ts
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { createAiRuntime } from 'vole/runtime-ai';

export async function updateOrder(page: Page) {
  const runtime = createAiRuntime(page);

  try {
    const actions = await runtime.observe('找到审批按钮');
    await runtime.act(actions[0]);

    const order = await runtime.extract(
      '读取当前订单状态',
      z.object({ status: z.string() })
    );

    await runtime.assert({
      instruction: '确认订单状态为已通过',
      kind: 'text',
      target: '订单状态',
      expected: '已通过'
    });

    return order;
  } finally {
    await runtime.close();
  }
}
```

多步骤任务使用 Agent：

```ts
const agent = runtime.agent({ mode: 'dom' });
const result = await agent.execute({
  instruction: '完成订单审批并验证最终状态',
  maxSteps: 10
});
```

`observe` 返回的 Action 可以直接传给 `act`。`act` 执行失败时会重新采集页面快照，只修复 selector，保留原 method 和 arguments。动作与 Agent 轨迹会缓存到 `.vole/ai-cache`。

`act`、`observe` 和 Agent 支持 `%variableName%` 占位符：

```ts
await runtime.act({
  instruction: '在邮箱输入框填写 %email%',
  variables: {
    email: {
      value: 'user@example.com',
      description: '登录邮箱'
    }
  }
});
```

Runtime 基于 Chromium CDP 合并 DOM 和 Accessibility Tree，可以处理 iframe、跨进程 iframe、开放或关闭的 Shadow DOM，以及 selector scope。模型只接收裁剪后的页面大纲，密码输入值会在快照阶段清理。

Agent 使用 AI SDK `ToolLoopAgent` 和 Vole 的 DOM 工具，默认最多执行 8 步，总超时 120 秒，导航限制在同源页面。它支持流式调用、callbacks、自定义 tools、消息续接、Zod 输出、usage 和 evidence。

## 配置要点

### AI Runtime

```json
{
  "runtimeAi": {
    "enabled": true,
    "timeoutMs": 30000,
    "selfHeal": true,
    "snapshotMaxChars": 60000,
    "cacheDir": ".vole/ai-cache",
    "artifactsDir": ".vole/artifacts/ai",
    "thinking": "disabled",
    "agent": {
      "maxSteps": 8,
      "timeoutMs": 120000,
      "toolTimeoutMs": 30000,
      "sameOriginOnly": true
    }
  }
}
```

关闭 `runtimeAi.enabled` 后，静态生成保持不变，无法静态解析的元素和业务动作不再使用 AI 兜底。部分 OpenAI-compatible 服务需要显式控制推理模式，可用 `runtimeAi.thinking` 设置 `enabled` 或 `disabled`。

### 日志

```json
{
  "logging": {
    "enabled": true,
    "level": "info",
    "directory": ".vole/logs",
    "retentionDays": 30,
    "maxFileSizeMb": 20
  }
}
```

日志写入：

```text
.vole/logs/YYYY-MM-DD/<invocationId>/
  cli.jsonl
  worker-<pid>.jsonl
```

CLI 主进程和 Playwright worker 使用同一个 `invocationId`。单个文件超过 `maxFileSizeMb` 后自动分片，每次启动会清理超过 `retentionDays` 的 Vole 日志。

日志只保存模型名、耗时、token、状态、哈希、计数和产物路径等诊断元数据，不记录模型 prompt、响应正文、DOM、页面文本、表单值、API Key、cookie、认证状态或截图内容。warning 和 error 同时写入 stderr。作为库使用时，可以通过 `createAiRuntime(page, { logger })` 注入 `VoleLogger`；未注入时不会自行创建日志文件。

## 运行产物与安全边界

| 路径 | 内容 |
| --- | --- |
| `.vole/kb.sqlite` | 页面、元素、业务动作、Test Plan 和运行记录 |
| `.vole/generated/plans` | 编译后与解析后的 Test Plan |
| `.vole/ai-cache` | 动作与 Agent 轨迹缓存 |
| `.vole/artifacts/ai` | AI 动作、断言、Agent 历史和失败证据 |
| `.vole/artifacts/results` | Playwright 运行结果、trace 和截图 |
| `.vole/logs` | CLI、Playwright worker 和 AI Runtime 的 JSONL 日志 |
| `.vole/auth` | Playwright storage state |

`.vole/vole.config.json`、认证状态、缓存、产物、日志和 SQLite 数据库默认加入 `.gitignore`。API Key 建议通过环境变量提供，不要写入版本库。AI 产物用于本地诊断，可能包含经过清理后的业务上下文，也不应提交。

上传文件路径只能来自 Test Plan 或调用方，模型不能自行生成本地文件路径。缓存会清理变量值，日志会进一步删除敏感字段并截断长字符串。

## CLI 命令

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

vole act <instruction> [--url <url>] [--headed] [--model <model>] [--timeout <ms>]
vole agent <instruction> [--url <url>] [--headed] [--model <model>] [--timeout <ms>] [--max-steps <count>]

vole run <specPath>
vole diagnose <runId|reportPath>
```

查看完整参数：

```bash
node dist/cli/index.js --help
node dist/cli/index.js <command> --help
```

## 测试

```bash
npm test
npm run test:runtime-ai
VOLE_LIVE_AI=1 npm run test:live-ai
```

`npm test` 运行 TypeScript 构建和单元测试。`test:runtime-ai` 还会启动真实 Chromium，覆盖 CDP 页面快照、iframe、Shadow DOM、动作矩阵、缓存、自愈、日志脱敏和 Agent 编排。`test:live-ai` 会调用真实模型，只用于显式启用的验收环境。

## 更多文档

- [使用指南](docs/usage-guide.md)
- [产品需求](docs/prd.md)
- [实施说明](docs/implementation-plan.md)
- [Demo 场景](docs/demo-scenarios.md)
