# Vole

Vole compiles Markdown test cases into reviewable, executable Playwright tests. It resolves pages, elements, and business actions from a local SQLite knowledge base, then uses an optional AI runtime when static data cannot identify a safe action.

```text
Markdown test case
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

Static resolution always runs first. Runtime discoveries do not modify the knowledge base or create hidden page state.

## Features

- Scan web pages and produce editable knowledge-base drafts.
- Compile Markdown cases into structured test plans.
- Generate Page Objects and Playwright specs from resolved plans.
- Fall back to AI for unresolved or ambiguous elements, assertions, and business actions.
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

For another OpenAI-compatible provider, update `ai.baseURL`, `ai.apiKeyEnv`, and `ai.model`. Agent mode requires a model that supports tool calling.

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
# Approve an order

Role: Operations manager

Preconditions:
- Order ORD-001 exists with a pending status

Steps:
- Open the orders page
- Search for order ORD-001
- Approve the order
- Verify that the order status is approved
```

The first heading is the case name. Role and preconditions are optional. Every case needs at least one step.

The built-in rules parser targets supported deterministic step patterns. Use the AI parser for freer wording or unsupported languages.

### Build and run

```bash
node dist/cli/index.js case build cases/order-approve.md --parser ai
```

`case build` compiles the case, resolves it against the knowledge base, generates Playwright code, and validates the generated TypeScript. Build every local case with:

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
| No element matches, or several elements match | Generate `ai-act` or `ai-assert` | Stop the build as unresolved or ambiguous |
| No business action matches, or several actions match | Generate `ai-agent` | Stop the build as unresolved or ambiguous |
| Page navigation is missing or ambiguous | Stop the build | Stop the build |

AI fallback only changes generated test code. It does not write runtime findings back to SQLite.

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
