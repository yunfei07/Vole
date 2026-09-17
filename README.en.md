# Vole

[简体中文](./README.md) | [English](./README.en.md)

An AI-powered tool for Web test automation, from understanding test intent to generating scripts and running Playwright tests.

## Introduction

Vole helps you build end-to-end tests for Web applications. Describe your test goals and steps in natural language, and Vole uses a local knowledge base to generate Page Objects and test scripts. Playwright runs the tests and saves the results.

By default, `case build` uses **buildAgent** to understand the goal, break it into actions and assertions, and generate a structured plan before producing code.

```text
Markdown test case
  → Goal analysis and step decomposition
  → TestPlan
  → Knowledge-base resolution
  → Playwright scripts
  → TypeScript validation
```

Key capabilities:

- **Natural-language cases**: write detailed steps or describe only the test goal.
- **Local knowledge base**: scan pages and store pages, elements, and business actions to generate static Playwright operations first.
- **AI fallback**: use runtime capabilities such as `act`, `observe`, and `agent` when operations cannot be resolved from the knowledge base.
- **AI assertions**: all generated business assertions use `this.ai.assert`.
- **Reviewable artifacts**: inspect analysis, plans, source code, execution results, and diagnostics.

Building a test does not launch a browser. Page scanning and test execution do. When critical data or expected results are missing, buildAgent lists the missing information and stops building that case.

## Installation

### Requirements

- Node.js **22.12 or newer**.
- npm and the Playwright Chromium browser.
- An OpenAI-compatible model service and API key for AI features. The runtime `agent` also requires a model that supports tool calling.

Run these commands in your test project's root directory:

```bash
npm install --save-dev @jeffyang07/vole
npx playwright install chromium
npx vole init
```

The npm package is `@jeffyang07/vole`; the CLI command is `vole`.

`init` creates the configuration, SQLite knowledge base, Playwright configuration, and working directories. Existing configuration files are preserved.

```text
.vole/
  vole.config.json       # Project configuration
  kb.sqlite              # Knowledge base and run records
  kb-drafts/             # Page scan drafts
  generated/plans/       # Analysis and test plans
  auth/                  # Authentication state
  ai-cache/              # AI cache
  artifacts/             # Execution evidence and results
  logs/                  # Structured logs
cases/                   # Markdown test cases
pages/                   # Generated Page Objects
tests/generated/         # Generated Playwright tests
playwright.config.ts
```

## Usage

The examples below assume a test application with a `/settings` page. Replace the URL, page names, elements, and expected results with those of your application.

### 1. Configure the project and model

Edit the following fields in `.vole/vole.config.json`, keeping the other settings created during initialization:

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

Set the API key through an environment variable:

```bash
export OPENAI_API_KEY="your API key"
```

For another compatible provider, change `ai.baseURL`, `ai.model`, and `ai.apiKeyEnv`. buildAgent uses the model, timeout, and retry settings under `ai`; browser AI execution is also controlled by `runtimeAi`.

For protected pages, configure the login URL, credentials, and element selectors under `auth`, then run:

```bash
npx vole auth login
```

Authentication state is saved at `auth.storageState`, which generated tests reference. For public pages, create an empty state file at that location containing `{"cookies":[],"origins":[]}`.

### 2. Scan pages and build the knowledge base

Scan and import every configured page:

```bash
npx vole kb scan --all --import
```

Alternatively, scan a single page, review the draft, and import it:

```bash
npx vole kb scan --name "系统设置页面" --url /settings --out .vole/kb-drafts/settings.json
npx vole kb import .vole/kb-drafts/settings.json
```

Inspect the knowledge base:

```bash
npx vole kb list pages
npx vole kb list elements --page "系统设置页面"
npx vole kb list actions
npx vole kb audit --page "系统设置页面"
```

Use consistent page and element names in cases and the knowledge base. AI fallback can handle unresolved operations, but unresolved page navigation still blocks the build.

### 3. Write a Markdown test case

Create `cases/settings-save.md`:

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

This case opens the settings page, changes the system name to `Vole 测试系统`, saves it, and verifies the confirmation message `设置已保存`.

The examples retain Chinese section labels because the Markdown parser currently recognizes these labels:

- `# Title` is required and becomes the case name.
- `角色：` (role) and `前置条件：` (preconditions) are optional.
- Under `步骤：` (steps), use `- ` bullets for operations and explicit expected results.
- Preconditions describe requirements that must already be satisfied. They do not automatically become login or data-creation steps.

Default AI builds also support goal-only cases:

```markdown
# 基础设置保存验证

前置条件：
- 已保存具有系统设置修改权限的管理员登录状态

目标：
进入系统设置页面，将系统名称修改为 Vole 测试系统并保存，验证提示消息为设置已保存。
```

You can use a `## 目标` heading instead of `目标：` (goal). Goals and steps can appear together. `--parser rules` and the standalone `case compile` command still require explicit steps. The rules compiler recognizes a fixed set of Chinese step patterns; use the Chinese example above when trying that path.

### 4. Build the test scripts

```bash
npx vole case build cases/settings-save.md --out tests/generated/settings-save.spec.ts
```

The default parser is `--parser ai`. buildAgent reads the complete case and a knowledge-base summary, separates compound operations and assertions, and converts each planned step into a TestPlan step. Generated scripts are checked with TypeScript.

Build artifacts:

| Artifact | Contents |
| --- | --- |
| `.vole/generated/plans/<case-name>.build.json` | Goal, acceptance criteria, planned steps, and missing information |
| `.vole/generated/plans/<case-name>.plan.json` | Structured TestPlan |
| `.vole/generated/plans/<case-name>.resolved.json` | Knowledge-base matches and AI fallback decisions |
| `pages/*.page.ts` | Page Objects containing operations and AI assertions |
| `tests/generated/*.spec.ts` | Playwright test entry points |

Use the paths printed by the CLI. Without `--out`, Vole chooses the script filename automatically.

If critical data or expected results are missing, the CLI lists the blockers and preserves `.build.json` for review. Update the case or knowledge base and rebuild. A failed build does not delete earlier successful artifacts; use the current command result to determine success.

Common options:

```bash
# Overwrite existing scripts
npx vole case build cases/settings-save.md --out tests/generated/settings-save.spec.ts --overwrite

# Build all cases in caseDir and report failures individually
npx vole case build --all

# Use the rules compiler, skipping AI goal analysis and decomposition
npx vole case build cases/settings-save.md --parser rules
```

Existing scripts are protected unless `--overwrite` is supplied. `--out` and `--page-object-out` apply only to single-case builds. Rules builds do not call a model for planning, but AI assertions and fallback in the generated scripts still require a model at execution time.

### 5. Run and diagnose

Review the generated plans and scripts, and prepare authentication state, test data, and other preconditions before running:

```bash
npx vole run tests/generated/settings-save.spec.ts
npx vole kb list runs
```

Diagnose a run using its ID:

```bash
npx vole diagnose <run-id>
```

`diagnose` also accepts a Playwright JSON report path. Results, screenshots, traces, and AI evidence are saved under `.vole/artifacts/`. Structured logs are saved under `.vole/logs/`.

### AI runtime capabilities

When the knowledge base has no reliable match, Vole selects runtime capabilities based on the step's intent:

| Capability | Purpose |
| --- | --- |
| `ai.act` | Perform a specific interaction, such as filling, clicking, or selecting |
| `ai.observe` | Return candidate actions from the current page without acting or asserting |
| `ai.agent` | Complete a task that requires multiple decisions based on the live page |
| `ai.extract` | Extract structured page data for later steps |
| `ai.assert` | Verify text, visibility, or business conditions |

The API is named `observe`. An unknown click can first use `observe` to find candidates, then `act` to execute. Unresolved business actions can use `agent`. Extraction does not replace assertions; generated business assertions always call `this.ai.assert`.

These capabilities require `runtimeAi.enabled: true`. When disabled, steps requiring AI fallback or AI assertions block the build. Runtime discoveries are not automatically written back to the knowledge base.

Run AI operations directly from the CLI:

```bash
npx vole act "点击保存设置按钮" --url /settings
npx vole agent "清除商品列表的所有筛选条件" --url /products --max-steps 12
```

Use the runtime in custom Playwright code with an existing `page`:

```ts
import { createAiRuntime } from '@jeffyang07/vole/runtime-ai';

const ai = createAiRuntime(page);
try {
  const result = await ai.act('Click the save settings button');
  if (!result.success) throw new Error(result.message);
  await ai.assert({
    instruction: 'Verify the save confirmation',
    kind: 'text',
    target: 'Confirmation message',
    expected: 'Settings saved'
  });
} finally {
  await ai.close();
}
```

Adapt the instructions and expected text to the application under test.

### Command reference

| Command | Purpose |
| --- | --- |
| `npx vole init` | Initialize a project |
| `npx vole auth login` | Log in and save browser state |
| `npx vole kb scan` | Scan pages and create knowledge-base drafts |
| `npx vole kb import <draftPath>` | Import a draft |
| `npx vole kb list <target>` | List pages, elements, actions, or runs |
| `npx vole kb audit` | Check knowledge-base quality |
| `npx vole case build <casePath>` | Analyze, plan, resolve, generate, and validate |
| `npx vole case compile <casePath>` | Compile a TestPlan separately |
| `npx vole case resolve <planPath>` | Resolve a plan against the knowledge base |
| `npx vole case generate <resolvedPlanPath>` | Generate scripts from a resolved plan |
| `npx vole run <specPath>` | Run a test and save its result |
| `npx vole diagnose <runId-or-reportPath>` | Analyze a run result |

For all options:

```bash
npx vole --help
npx vole case build --help
npx vole kb scan --help
```

## Development and troubleshooting

Run from source:

```bash
npm ci
npx playwright install chromium
npm run build
node dist/cli/index.js --help
npm test
npm run test:runtime-ai
```

- **SQLite fails to load after switching Node.js versions**: run `npm rebuild better-sqlite3` to rebuild the native module.
- **Page navigation cannot be resolved**: check that the page was imported and its name and URL are correct.
- **A goal-only case fails to build**: use the default AI build, check model configuration, and review missing items in `.build.json`.
- **An output file already exists**: review it before using `--overwrite`, or choose another path with `--out`.
- **Older scripts import `vole/runtime-ai`**: regenerate them after migrating to the scoped package. The entry point is `@jeffyang07/vole/runtime-ai`.

Pass API keys through environment variables. Initialization adds local configuration, authentication state, the knowledge base, caches, logs, and execution artifacts to `.gitignore`. Check staged files before committing.

## License

Licensed under the [MIT License](./LICENSE).
