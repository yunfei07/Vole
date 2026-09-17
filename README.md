# Vole

[简体中文](./README.md) | [English](./README.en.md)

AI 驱动的 Web 自动化测试工具，支持测试意图理解、脚本生成与 Playwright 测试执行。

## 介绍

Vole 面向 Web 应用的端到端测试。你用自然语言描述测试目标和步骤，Vole 结合本地知识库生成 Page Object 和测试脚本，再通过 Playwright 执行并保存结果。

默认的 `case build` 使用 **buildAgent**：先理解目标、拆解操作与断言，再生成结构化计划和脚本。

```text
Markdown 用例
  → 目标理解与步骤拆解
  → TestPlan
  → 知识库匹配
  → Playwright 脚本
  → TypeScript 校验
```

主要能力：

- **自然语言用例**：支持详细步骤，也支持只描述目标的用例。
- **本地知识库**：扫描页面，保存页面、元素和业务动作，优先生成静态 Playwright 操作。
- **AI 补充执行**：知识库无法匹配操作时，使用 `act`、`observe`、`agent` 等运行时能力。
- **统一 AI 断言**：生成脚本中的业务断言全部使用 `this.ai.assert`。
- **可检查的产物**：保存拆解分析、测试计划、源码、执行结果和诊断信息。

构建阶段不启动浏览器。页面扫描和测试执行阶段会操作浏览器。缺少关键数据或预期结果时，buildAgent 会列出缺失项并停止当前用例的构建。

## 安装

### 环境要求

- Node.js **22.12 或更高版本**。
- npm 和 Playwright Chromium 浏览器。
- AI 功能需要支持 OpenAI 兼容接口的模型服务及 API Key；运行时 `agent` 还要求模型支持工具调用。

在测试项目根目录执行：

```bash
npm install --save-dev @jeffyang07/vole
npx playwright install chromium
npx vole init
```

npm 包名是 `@jeffyang07/vole`，命令名是 `vole`。

`init` 创建配置、SQLite 知识库、Playwright 配置及工作目录，保留已有配置文件：

```text
.vole/
  vole.config.json       # 项目配置
  kb.sqlite              # 本地知识库与运行记录
  kb-drafts/             # 页面扫描草稿
  generated/plans/       # 分析与测试计划
  auth/                  # 登录状态
  ai-cache/              # AI 缓存
  artifacts/             # 执行证据与结果
  logs/                  # 结构化日志
cases/                   # Markdown 用例
pages/                   # 生成的 Page Object
tests/generated/         # 生成的 Playwright 测试
playwright.config.ts
```

## 使用

以下示例使用一个提供 `/settings` 页面的测试后台。请将地址、页面名称、元素和预期结果替换为你的应用内容。

### 1. 配置项目和模型

编辑 `.vole/vole.config.json`，修改以下字段，保留初始化生成的其他配置：

```json
{
  "baseUrl": "http://127.0.0.1:4173",
  "scanPages": [
    { "name": "系统设置页面", "url": "/settings" }
  ],
  "ai": {
    "provider": "openai-compatible",
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "gpt-4.1",
    "temperature": 0.1,
    "timeoutMs": 30000,
    "maxRetries": 2,
    "structuredOutputMode": "auto"
  }
}
```

将 API Key 放入环境变量：

```bash
export OPENAI_API_KEY="你的 API Key"
```

使用其他兼容服务时，调整 `ai.baseURL`、`ai.model` 和 `ai.apiKeyEnv`。buildAgent 使用 `ai` 中的模型、超时及重试设置；浏览器中的 AI 执行还受 `runtimeAi` 配置控制。

如果页面需要登录，先配置 `auth` 中的登录地址、账号、密码和元素选择器，然后执行：

```bash
npx vole auth login
```

登录状态保存到 `auth.storageState` 指定的位置，生成的测试会引用该文件。测试公开页面时，可以在该位置准备内容为 `{"cookies":[],"origins":[]}` 的空状态文件。

### 2. 扫描页面，建立知识库

扫描配置中的所有页面并导入：

```bash
npx vole kb scan --all --import
```

也可以先扫描单页，检查草稿后再导入：

```bash
npx vole kb scan --name "系统设置页面" --url /settings --out .vole/kb-drafts/settings.json
npx vole kb import .vole/kb-drafts/settings.json
```

查看和检查知识库：

```bash
npx vole kb list pages
npx vole kb list elements --page "系统设置页面"
npx vole kb list actions
npx vole kb audit --page "系统设置页面"
```

用例中的页面和元素名称尽量与知识库保持一致。AI fallback 可以补充未匹配的操作，但无法解析的页面导航仍会阻止构建。

### 3. 编写 Markdown 用例

创建 `cases/settings-save.md`：

```markdown
# 基础设置保存验证

角色：admin

前置条件：
- 已保存管理员登录状态
- 管理员有修改系统设置的权限

步骤：
- 进入系统设置页面
- 在系统名称输入框输入 Vole 测试系统
- 点击保存设置按钮
- 断言提示消息为设置已保存
```

格式约定：

- `# 标题` 必填，作为用例名称。
- `角色：` 和 `前置条件：` 可选。
- `步骤：` 下使用 `- ` 列表，描述业务操作和明确的预期结果。
- 前置条件是执行前需要满足的环境要求，不会自动转成登录或创建数据的操作。

默认 AI 构建也支持目标式用例：

```markdown
# 基础设置保存验证

前置条件：
- 已保存具有系统设置修改权限的管理员登录状态

目标：
进入系统设置页面，将系统名称修改为 Vole 测试系统并保存，验证提示消息为设置已保存。
```

`目标：` 也可以写成 `## 目标` 标题段落。目标和步骤可以同时提供；`--parser rules` 和独立的 `case compile` 仍要求显式步骤。

### 4. 构建测试脚本

```bash
npx vole case build cases/settings-save.md --out tests/generated/settings-save.spec.ts
```

默认使用 `--parser ai`。buildAgent 会读取完整用例及知识库摘要，拆分复合操作、单独列出断言，再将规划步骤逐一转换为 TestPlan。生成脚本后执行 TypeScript 校验。

构建产物：

| 产物 | 内容 |
| --- | --- |
| `.vole/generated/plans/<用例名>.build.json` | 测试目标、验收条件、拆解步骤与缺失项 |
| `.vole/generated/plans/<用例名>.plan.json` | 结构化 TestPlan |
| `.vole/generated/plans/<用例名>.resolved.json` | 知识库匹配与 AI fallback 结果 |
| `pages/*.page.ts` | Page Object，包含具体操作与 AI 断言 |
| `tests/generated/*.spec.ts` | Playwright 测试入口 |

实际文件名以终端输出为准。未指定 `--out` 时，Vole 自动生成脚本文件名。

如果缺少关键数据或预期结果，终端会列出阻塞原因，并保留 `.build.json` 供检查。补充用例或知识库后重新构建；失败不会删除历史成功产物，应以本次命令结果判断是否成功。

常用选项：

```bash
# 覆盖已有脚本
npx vole case build cases/settings-save.md --out tests/generated/settings-save.spec.ts --overwrite

# 批量构建 caseDir 中的用例，逐例处理并汇总失败
npx vole case build --all

# 使用规则编译器，跳过 AI 目标理解与拆解
npx vole case build cases/settings-save.md --parser rules
```

默认禁止覆盖已有脚本。`--out` 和 `--page-object-out` 仅用于单个用例。规则构建不调用模型进行规划，但生成脚本中的 AI 断言和 fallback 在执行时仍需要模型。

### 5. 执行和诊断

执行前检查生成的计划和脚本，确保登录状态、测试数据及其他前置条件已经准备好：

```bash
npx vole run tests/generated/settings-save.spec.ts
npx vole kb list runs
```

使用运行记录中的 ID 查看诊断：

```bash
npx vole diagnose <run-id>
```

`diagnose` 也接受 Playwright JSON 报告路径。执行结果、截图、trace 和 AI 证据保存在 `.vole/artifacts/`；结构化日志保存在 `.vole/logs/`。

### AI 运行时能力

当知识库缺少可靠匹配时，Vole 根据步骤意图选择运行时能力：

| 能力 | 用途 |
| --- | --- |
| `ai.act` | 执行明确的操作，例如输入、点击、选择 |
| `ai.observe` | 观察页面并返回候选操作，本身不执行操作或断言 |
| `ai.agent` | 完成需要根据当前页面进行多步决策的任务 |
| `ai.extract` | 按结构提取页面数据，供后续步骤使用 |
| `ai.assert` | 验证文本、可见性或业务条件 |

实际 API 名为 `observe`。未知点击可先通过 `observe` 找到候选，再交给 `act` 执行；无法匹配的业务动作可交给 `agent`。数据提取不代替断言，生成脚本中的业务断言统一调用 `this.ai.assert`。

这些能力需要 `runtimeAi.enabled: true`。关闭后，需要 AI fallback 或 AI 断言的步骤会阻止构建。运行时发现不会自动回写知识库。

也可以直接从命令行执行 AI 操作：

```bash
npx vole act "点击保存设置按钮" --url /settings
npx vole agent "清除商品列表的所有筛选条件" --url /products --max-steps 12
```

在自定义 Playwright 代码中使用运行时入口：

```ts
import { createAiRuntime } from '@jeffyang07/vole/runtime-ai';

const ai = createAiRuntime(page);
try {
  const result = await ai.act('点击保存设置按钮');
  if (!result.success) throw new Error(result.message);
  await ai.assert({
    instruction: '验证保存成功提示',
    kind: 'text',
    target: '提示消息',
    expected: '设置已保存'
  });
} finally {
  await ai.close();
}
```

### 命令速查

| 命令 | 用途 |
| --- | --- |
| `npx vole init` | 初始化项目 |
| `npx vole auth login` | 登录并保存浏览器状态 |
| `npx vole kb scan` | 扫描页面并生成知识库草稿 |
| `npx vole kb import <draftPath>` | 导入知识库草稿 |
| `npx vole kb list <target>` | 查看页面、元素、动作或运行记录 |
| `npx vole kb audit` | 检查知识库质量 |
| `npx vole case build <casePath>` | 理解、规划、匹配、生成并校验脚本 |
| `npx vole case compile <casePath>` | 单独编译 TestPlan |
| `npx vole case resolve <planPath>` | 单独匹配知识库 |
| `npx vole case generate <resolvedPlanPath>` | 根据匹配结果生成脚本 |
| `npx vole run <specPath>` | 执行测试并保存运行记录 |
| `npx vole diagnose <runId或reportPath>` | 分析运行结果 |

查看完整参数：

```bash
npx vole --help
npx vole case build --help
npx vole kb scan --help
```

## 开发与常见问题

从源码运行：

```bash
npm ci
npx playwright install chromium
npm run build
node dist/cli/index.js --help
npm test
npm run test:runtime-ai
```

- **切换 Node.js 后 SQLite 加载失败**：运行 `npm rebuild better-sqlite3` 重建原生模块。
- **页面导航无法解析**：检查页面是否导入知识库、名称是否一致、地址是否正确。
- **目标式用例构建失败**：确认使用默认 AI 构建，检查模型配置及 `.build.json` 中的缺失项。
- **提示文件已存在**：检查现有文件后使用 `--overwrite`，或通过 `--out` 指定新路径。
- **旧脚本导入 `vole/runtime-ai`**：迁移到作用域包后重新生成，入口应为 `@jeffyang07/vole/runtime-ai`。

API Key 使用环境变量传入。初始化会将本地配置、登录状态、知识库、缓存、日志和执行产物加入 `.gitignore`；提交前仍需检查待提交文件。

## 许可证

本项目采用 [MIT 开源许可证](./LICENSE)。
