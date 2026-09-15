# Vole

Vole compiles Markdown test cases into reviewable, executable Playwright tests. It resolves pages, elements, and business actions from a local SQLite knowledge base, then uses an optional AI runtime when static data cannot identify a safe action.

```text
Markdown test case
        |
        v
Goal analysis and step decomposition (buildAgent)
        |
        v
Structured test plan
        |
        v
Static knowledge-base resolution
        |
        v
Playwright code generation
        |
        v
Execution, artifacts, and diagnostics
```

Static resolution runs first for actions. All generated assertions use `this.ai.assert` and require runtime AI. Runtime discoveries do not modify the knowledge base or create hidden page state.

## Features

- Scan web pages and produce editable knowledge-base drafts.
- Understand Markdown test goals and decompose them into reviewable steps before compiling structured test plans.
- Generate Page Objects and Playwright specs from resolved plans.
- Fall back to AI for unresolved or ambiguous elements and business actions. Use AI assertions for all verification.
- Run one AI browser action from the CLI or delegate a multi-step task to an agent.
- Capture Playwright reports, traces, screenshots, AI artifacts, and structured JSONL logs.
- Correlate CLI, Playwright worker, knowledge-base, and model events with one invocation ID.

## Requirements

- Node.js 22
- npm
- Chromium supported by Playwright
- An OpenAI-compatible model and API key for AI features

Rebuild the SQLite native module after changing Node.js versions if Node reports an ABI mismatch:

```bash
npm rebuild better-sqlite3
```

## Installation

```bash
npm install
npx playwright install chromium
npm run build
node dist/cli/index.js init
```

`init` creates the project configuration, SQLite knowledge base, Playwright configuration, and local runtime directories. It does not overwrite existing files.

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

The main configuration file is `.vole/vole.config.json`. Review these settings after initialization:

- `baseUrl` points to the application under test.
- `scanPages` lists pages available to bulk scanning.
- `auth` defines the login flow and storage-state path.
- `ai` selects the model endpoint, model name, and API-key source.
- `runtimeAi` controls AI fallback, caching, self-healing, and agent limits.
- `playwright` and `pageReady` control browser and readiness behavior.
- `logging` controls the log level, location, retention, and file size.

The default configuration reads the model credential from `OPENAI_API_KEY`:

```bash
export OPENAI_API_KEY="..."
```

For another OpenAI-compatible provider, update `ai.baseURL`, `ai.apiKeyEnv`, and `ai.model`. The browser runtime agent requires tool calling; buildAgent uses structured output and does not require tool calling.

## Quick start

### Save authenticated browser state

Run the login flow before scanning or testing protected pages:

```bash
node dist/cli/index.js auth login
```

Vole saves browser state at the path configured by `auth.storageState`. Skip this step for public pages.

### Build the knowledge base

Scan every page listed in `scanPages` and import the results:

```bash
node dist/cli/index.js kb scan --all --import
```

For a review-first workflow, save a draft and import it after inspection:

```bash
node dist/cli/index.js kb scan \
  --name "Orders" \
  --url "/orders" \
  --out ".vole/kb-drafts/orders.json"

node dist/cli/index.js kb import .vole/kb-drafts/orders.json
node dist/cli/index.js kb audit --page "Orders"
```

Inspect imported records with:

```bash
node dist/cli/index.js kb list pages
node dist/cli/index.js kb list elements --page "Orders"
node dist/cli/index.js kb list actions
```

### Write a test case

Create a Markdown file under `cases/`:

```markdown
# 订单审批通过

角色：admin

前置条件：
- 订单 ORD-001 已存在，状态为待审批；已保存管理员登录状态

步骤：
- 进入订单管理页面
- 搜索订单编号 ORD-001
- 点击审批按钮
- 点击通过按钮
- 断言订单状态为已通过
```

The level-one heading is the case name. Role and preconditions are optional. Use the Chinese section labels shown above; step lists use `-` bullets.

Default AI builds also accept a goal without a step list:

```markdown
# 订单审批通过

角色：admin

前置条件：
- 订单 ORD-001 已存在，状态为待审批；已保存管理员登录状态

## 目标
在订单管理页面审批订单 ORD-001，验证该订单的状态变为已通过。
```

`目标：` followed by inline or multiline text is also supported. Goals and steps can be combined. The built-in rules parser and standalone `case compile` still require at least one explicit step.

### Build and run

```bash
node dist/cli/index.js case build cases/order-approve.md --parser ai
```

`case build` defaults to `--parser ai`, which uses buildAgent in two stages:

1. Read the complete case and the knowledge-base semantic summary; identify the goal, acceptance criteria, and ordered actions and assertions.
2. Convert those steps one-for-one into a TestPlan, then resolve against the same knowledge-base snapshot, generate Playwright code, and validate TypeScript.

buildAgent uses `ai.model`, `ai.timeoutMs`, and `ai.maxRetries`. It does not launch a browser or execute the test. Preconditions remain environment requirements, rather than implicit setup actions. It does not invent required data or expected outcomes.

The first stage saves `.vole/generated/plans/<case-slug>.build.json` with the goal, preconditions, acceptance criteria, steps (instruction, action/assertion kind, and source), and `missingItems`. If information is missing, the build prints the missing items and stops that case before compilation or script generation. Inspect this file, update the case or knowledge base, and rebuild. Successful builds also save the existing `.plan.json` and `.resolved.json` artifacts. A failed rebuild does not remove older successful artifacts; the current command result determines whether the build succeeded.

Use `--parser rules` for the existing deterministic compilation path. `case compile`, `case resolve`, and `case generate` retain their separate workflows. Build every local case with:

```bash
node dist/cli/index.js case build --all --parser ai
```

Run the generated spec and inspect its result:

```bash
node dist/cli/index.js run tests/generated/case-example.spec.ts
node dist/cli/index.js kb list runs
node dist/cli/index.js diagnose <run-id>
```

`diagnose` accepts either a run ID or a Playwright JSON report path.

## Static resolution and AI fallback

The resolver searches records within the active page, removes low-confidence candidates, and rejects candidates with incompatible element types.

| Resolution result | Runtime AI enabled | Runtime AI disabled |
| --- | --- | --- |
| One page, element, or business action matches | Generate static Playwright code | Generate static Playwright code |
| No action element matches, or several elements match | Generate `ai-act` | Stop the build as unresolved or ambiguous |
| Any assertion, including a known element | Generate `ai-assert` | Stop the build |
| No business action matches, or several actions match | Generate `ai-agent` | Stop the build as unresolved or ambiguous |
| Page navigation is missing or ambiguous | Stop the build | Stop the build |

AI fallback only changes generated test code. It does not write runtime findings back to SQLite.

### Exercise observe, act, agent, and extract

`cases/build-agent-runtime-capabilities.md` covers product filtering, structured extraction, and an agent task that restores the full list. Build it with an isolated knowledge base containing only the product page:

```bash
npm run build
node examples/build-agent-runtime-smoke.mjs
```

This calls the configured model and writes plans and scripts under `.vole/build-agent-runtime-smoke/`, without changing the main knowledge base or starting a browser. The example runner overwrites its own generated scripts on subsequent runs.

The example cases use the same `# title`, `前置条件：`, and `步骤：` bullet-list format as the other cases. They contain business instructions without API names or special test-data/acceptance sections. buildAgent chooses capabilities from the intent and knowledge-base coverage:

- Clear individual interactions use static locators when available and `ai.act` otherwise. `act` can also handle a tightly coupled two-step interaction and repair stale locators.
- Unknown clicks use `ai.observe` to discover current actions. A unique click candidate is executed immediately with `ai.act(candidate)`; zero or multiple candidates fall back to the complete original instruction. Observation alone neither acts nor asserts.
- Bounded tasks requiring live page decisions, such as clearing all filters, remain `businessAction` steps and use `ai.agent` when no KB action matches. The agent verifies its own completion, while case assertions remain separate.
- Data-recording steps use `extract`, whose `fields` map names to `{ description }`. Results are stored in the shared context. Extraction is not an assertion; legacy field expectations are checked via `this.ai.assert`.
- All assertions use `this.ai.assert`: `assertText` uses text equality (or containment for lists), `assertVisible` checks visibility, and `assertSemantic` handles counts or multiple conditions. Generated code does not use Playwright `expect`.

These AI operations require `runtimeAi.enabled`. Standalone `observe` is supported for explicit observation instructions; it is not automatically inserted as an unused preliminary step.

## AI Runtime

Use `act` for one browser instruction:

```bash
node dist/cli/index.js act "Click the search button" --url /products
```

Use `agent` for a multi-step task:

```bash
node dist/cli/index.js agent \
  "Clear all filters and verify that every product is visible" \
  --url /products \
  --max-steps 12
```

Applications can also import the runtime:

```ts
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { createAiRuntime } from 'vole/runtime-ai';

export async function approveOrder(page: Page) {
  const runtime = createAiRuntime(page);

  try {
    const actions = await runtime.observe('Find the approve button');
    await runtime.act(actions[0]);

    const order = await runtime.extract(
      'Read the current order status',
      z.object({ status: z.string() })
    );

    await runtime.assert({
      instruction: 'Verify that the order is approved',
      kind: 'text',
      target: 'Order status',
      expected: 'Approved'
    });

    return order;
  } finally {
    await runtime.close();
  }
}
```

Run a multi-step agent through the same runtime:

```ts
const agent = runtime.agent({ mode: 'dom' });
const result = await agent.execute({
  instruction: 'Approve the order and verify its final status',
  maxSteps: 10
});
```

`observe` returns actions that can be passed directly to `act`. When an action fails, self-healing captures a new page snapshot and repairs the selector while preserving the original method and arguments.

Instructions support `%variableName%` placeholders:

```ts
await runtime.act({
  instruction: 'Fill the email field with %email%',
  variables: {
    email: {
      value: 'user@example.com',
      description: 'Account email'
    }
  }
});
```

The runtime combines Chromium DOM and accessibility data. It supports iframes, out-of-process iframes, open and closed Shadow DOM, and scoped selectors. Password values are removed while the snapshot is built.

The DOM agent uses AI SDK tool calling and limits navigation to same-origin pages by default. It supports streaming, callbacks, custom tools, message continuation, Zod output, token usage, and execution evidence.

## Runtime configuration

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

Disabling `runtimeAi.enabled` leaves static generation unchanged and turns unresolved AI-compatible steps into build errors.

## Logging

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

Vole writes one directory per CLI invocation:

```text
.vole/logs/YYYY-MM-DD/<invocationId>/
  cli.jsonl
  worker-<pid>.jsonl
```

The CLI process and Playwright workers share one `invocationId`. Vole rotates files after `maxFileSizeMb` and removes owned log files older than `retentionDays`.

Logs contain diagnostic metadata such as model names, durations, token usage, statuses, hashes, counts, and artifact paths. They do not contain prompts, model responses, DOM text, form values, API keys, cookies, storage state, or screenshot data.

Library consumers can inject a `VoleLogger` through `createAiRuntime(page, { logger })`. The runtime remains silent and does not create files when no logger is supplied.

## Local data and security

| Path | Contents |
| --- | --- |
| `.vole/kb.sqlite` | Pages, elements, business actions, test plans, and run records |
| `.vole/generated/plans` | Compiled and resolved test plans |
| `.vole/ai-cache` | Action and agent trajectory cache |
| `.vole/artifacts/ai` | AI action, assertion, agent history, and failure evidence |
| `.vole/artifacts/results` | Playwright results, traces, and screenshots |
| `.vole/logs` | CLI, worker, and AI Runtime JSONL logs |
| `.vole/auth` | Playwright storage state |

Vole ignores local configuration, authentication state, caches, artifacts, logs, the SQLite database, cases, generated tests, and local project documentation. Keep API keys in environment variables.

Model-generated actions cannot invent local upload paths. Upload paths must come from the test plan or the calling application. Cache keys remove variable values, and the logger redacts sensitive fields before serialization.

## CLI reference

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

Show the complete command help with:

```bash
node dist/cli/index.js --help
node dist/cli/index.js <command> --help
```
