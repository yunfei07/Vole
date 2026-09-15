import path from 'node:path';
import type { ResolvedPlan, ResolvedStep } from '../resolver/types.js';
import type { ActionRow, ElementRow, PageRow } from '../kb/repository.js';
import { stableId } from '../utils/id.js';

export type CodegenKb = {
  pages: PageRow[];
  elements: ElementRow[];
  actions: ActionRow[];
};

export type GeneratedFiles = {
  specPath: string;
  pageObjectPath: string;
  specSource: string;
  pageObjectSource: string;
};

export type GenerateOptions = {
  cwd: string;
  testDir: string;
  pageObjectDir: string;
  baseUrl: string;
  storageState: string;
  ignoreHTTPSErrors: boolean;
  playwrightTimeoutMs: number;
  runtimeAiTimeoutMs: number;
  agentTimeoutMs: number;
  specOut?: string;
  pageObjectOut?: string;
};

type StepRender = {
  methodName: string;
  rawText: string;
  body: string[];
  usesAi: boolean;
};

export function generateTestFiles(plan: ResolvedPlan, kb: CodegenKb, options: GenerateOptions): GeneratedFiles {
  if (plan.status !== 'resolved') {
    throw new Error(`CODEGEN_FAILED: resolved plan status must be resolved, got ${plan.status}`);
  }

  const baseName = `case-${stableId('', [plan.name]).replace(/^_/, '')}`;
  const pageObjectPath = path.resolve(options.cwd, options.pageObjectOut ?? path.join(options.pageObjectDir, `${baseName}.page.ts`));
  const specPath = path.resolve(options.cwd, options.specOut ?? path.join(options.testDir, `${baseName}.spec.ts`));
  const className = 'GeneratedCasePage';
  const stepRenders = plan.steps.map((step, index) => renderStep(plan, step, index, kb, options));
  const usesAi = stepRenders.some((step) => step.usesAi);
  const pageObjectSource = renderPageObject(className, stepRenders, usesAi ? 'vole/runtime-ai' : undefined,
    plan.steps.some((item) => item.step.action === 'extract'));
  const specSource = renderSpec(plan, className, stepRenders, {
    pageObjectPath,
    specPath,
    storageState: options.storageState,
    ignoreHTTPSErrors: options.ignoreHTTPSErrors,
    usesAi,
    testTimeoutMs: usesAi ? calculateAiTestTimeout(plan, options) : undefined
  });

  return {
    specPath,
    pageObjectPath,
    specSource,
    pageObjectSource
  };
}

function renderPageObject(className: string, steps: StepRender[], runtimeImportPath?: string, usesExtract = false): string {
  return `${[
    "import { type Locator, type Page } from '@playwright/test';",
    usesExtract ? "import { z } from 'zod';" : undefined,
    runtimeImportPath
      ? `import { createAiRuntime, type AiRuntime } from '${runtimeImportPath}';`
      : undefined,
    '',
    'type TestContext = Record<string, string>;',
    '',
    `export class ${className} {`,
    runtimeImportPath ? '  public readonly ai: AiRuntime;' : undefined,
    '',
    runtimeImportPath
      ? '  constructor(private readonly page: Page) {\n    this.ai = createAiRuntime(page);\n  }'
      : '  constructor(private readonly page: Page) {}',
    runtimeImportPath ? '\n  async close(): Promise<void> {\n    await this.ai.close();\n  }' : undefined,
    '',
    '  private orderRow(orderNo: string): Locator {',
    "    return this.page.getByRole('row').filter({ hasText: orderNo });",
    '  }',
    '',
    '  private rowByText(text: string): Locator {',
    "    return this.page.getByRole('row').filter({ hasText: text });",
    '  }',
    '',
    ...steps.flatMap((step) => renderMethod(step)),
    '}',
    ''
  ].filter((line): line is string => line !== undefined).join('\n')}`;
}

function renderMethod(step: StepRender): string[] {
  return [
    `  async ${step.methodName}(context: TestContext): Promise<void> {`,
    `    // ${step.rawText.replace(/[\r\n]+/g, ' ')}`,
    ...step.body.map((line) => `    ${line}`),
    '  }',
    ''
  ];
}

function renderSpec(
  plan: ResolvedPlan,
  className: string,
  steps: StepRender[],
  paths: {
    pageObjectPath: string;
    specPath: string;
    storageState: string;
    ignoreHTTPSErrors: boolean;
    usesAi: boolean;
    testTimeoutMs?: number;
  }
): string {
  const importPath = toImportPath(path.relative(path.dirname(paths.specPath), paths.pageObjectPath));
  return `${[
    "import { test } from '@playwright/test';",
    `import { ${className} } from '${importPath}';`,
    '',
    `test.use({ storageState: ${quote(paths.storageState)}, ignoreHTTPSErrors: ${String(paths.ignoreHTTPSErrors)} });`,
    '',
    `test(${quote(plan.name)}, async ({ page }) => {`,
    paths.testTimeoutMs ? `  test.setTimeout(${paths.testTimeoutMs});` : undefined,
    `  const flow = new ${className}(page);`,
    '  const context: Record<string, string> = {};',
    paths.usesAi ? '  try {' : undefined,
    ...steps.map((step) => `${paths.usesAi ? '  ' : ''}  await flow.${step.methodName}(context);`),
    paths.usesAi ? '  } finally {\n    await flow.close();\n  }' : undefined,
    '});',
    ''
  ].filter((line): line is string => line !== undefined).join('\n')}`;
}

function calculateAiTestTimeout(plan: ResolvedPlan, options: GenerateOptions): number {
  return plan.steps.reduce((timeout, item) => {
    if (item.resolution.status !== 'ai_fallback') {
      return timeout + (item.step.action.startsWith('assert') || item.step.action === 'businessAction' ? options.runtimeAiTimeoutMs * 3 : 0);
    }

    return timeout + (
      item.resolution.execution === 'ai-agent'
        ? options.agentTimeoutMs
        : options.runtimeAiTimeoutMs * (item.step.action === 'assertSemantic' ? 3 : 2)
    );
  }, options.playwrightTimeoutMs);
}

function renderStep(plan: ResolvedPlan, resolvedStep: ResolvedStep, index: number, kb: CodegenKb, options: GenerateOptions): StepRender {
  const methodName = `step${String(index + 1).padStart(3, '0')}`;
  const step = resolvedStep.step;
  const matched = resolvedStep.resolution.matched;
  if (resolvedStep.resolution.status === 'ai_fallback' || step.action.startsWith('assert')) {
    return renderAiFallback(methodName, resolvedStep);
  }

  if (!matched) {
    throw new Error(`CODEGEN_FAILED: step is not resolved: ${step.id}`);
  }

  if (step.action === 'goto') {
    const page = kb.pages.find((item) => item.id === matched.id || item.name === matched.semanticName);
    if (!page) {
      throw new Error(`CODEGEN_FAILED: page not found for step ${step.id}`);
    }

    return {
      methodName,
      rawText: step.rawText,
      body: [`await this.page.goto(${quote(joinUrl(options.baseUrl, page.url))});`],
      usesAi: false
    };
  }

  if (step.action === 'businessAction') {
    const action = kb.actions.find((item) => item.id === matched.id || item.name === matched.semanticName);
    if (!action?.steps_json) {
      throw new Error(`CODEGEN_FAILED: business action not found for step ${step.id}`);
    }

    const body: string[] = [];
    if (step.inputs) {
      for (const [key, value] of Object.entries(step.inputs)) {
        body.push(`context[${quote(key)}] = ${quote(value)};`);
      }
    }

    const actionSteps = JSON.parse(action.steps_json) as Array<{ action: string; target: string; value?: string }>;
    for (const actionStep of actionSteps) {
      body.push(...renderPrimitive(actionStep.action, actionStep.target, interpolateLiteral(actionStep.value ?? '', step.inputs), kb));
    }

    return {
      methodName,
      rawText: step.rawText,
      body,
      usesAi: body.some((line) => line.includes('this.ai.'))
    };
  }

  return {
    methodName,
    rawText: step.rawText,
    body: renderPrimitive(
      step.action,
      step.target ?? '',
      step.action === 'upload' ? step.filePath : 'value' in step ? step.value : '',
      kb,
      matched.locator
    ),
    usesAi: false
  };
}

function renderAiFallback(methodName: string, resolvedStep: ResolvedStep): StepRender {
  const step = resolvedStep.step;
  if (step.action === 'observe') {
    return {
      methodName, rawText: step.rawText, usesAi: true,
      body: [
        `await this.ai.observe(${quote(step.rawText)}, { variables: context });`
      ]
    };
  }
  if (step.action === 'extract') {
    const fields = Object.entries(step.fields);
    if (fields.length === 0) throw new Error(`CODEGEN_FAILED: extract step ${step.id} has no fields`);
    return {
      methodName, rawText: step.rawText, usesAi: true,
      body: [
        // Do not send expected answers to the extraction model: verify independently below.
        `const extracted = await this.ai.extract(${quote('从当前可见页面提取以下字段，仅返回页面实际呈现的事实。')}, z.object({`,
        ...fields.map(([name, field]) => `  [${quote(name)}]: z.string().describe(${quote(field.description)}),`),
        '}));',
        ...fields.flatMap(([name, field]) => [
          ...(field.expected !== undefined ? [
            `await this.ai.assert({ instruction: ${quote(`${field.description}应为${field.expected}`)}, target: ${quote(field.description)}, kind: 'semantic', expected: ${quote(field.expected)}, variables: context });`
          ] : []),
          `context[${quote(name)}] = extracted[${quote(name)}];`
        ])
      ]
    };
  }
  const common = [
    `instruction: ${quote(step.rawText)}`,
    step.target ? `target: ${quote(step.target)}` : undefined,
    'variables: context'
  ].filter((line): line is string => Boolean(line));

  if (resolvedStep.resolution.execution === 'ai-agent') {
    const body: string[] = [];
    if (step.action === 'businessAction' && step.inputs) {
      for (const [key, value] of Object.entries(step.inputs)) {
        body.push(`context[${quote(key)}] = ${quote(value)};`);
      }
    }
    const agentInput = [
      `instruction: ${quote(step.rawText)}`,
      'variables: context'
    ];
    body.push(`const aiResult = await this.ai.agent({ ${agentInput.join(', ')} });`);
    body.push(`if (!aiResult.success) throw new Error(aiResult.message);`);
    return { methodName, rawText: step.rawText, body, usesAi: true };
  }

  if (step.action.startsWith('assert')) {
    if (step.action === 'assertText') {
      return {
        methodName,
        rawText: step.rawText,
        body: [`await this.ai.assert({ ${common.join(', ')}, kind: ${quote(step.target.includes('列表') ? 'containsText' : 'text')}, expected: ${quote(step.value)} });`],
        usesAi: true
      };
    }
    if (step.action === 'assertSemantic') {
      return { methodName, rawText: step.rawText, usesAi: true,
        body: [`await this.ai.assert({ ${common.join(', ')}, kind: 'semantic', expected: ${quote(step.value)} });`] };
    }
    return {
      methodName,
      rawText: step.rawText,
      body: [`await this.ai.assert({ ${common.join(', ')}, kind: 'visible' });`],
      usesAi: true
    };
  }

  const action = aiActionForStep(step.action);
  const values = [
    ...common,
    // Unknown dropdowns may need click-to-open then click-to-select, not selectOption.
    step.action !== 'select' ? `action: ${quote(action)}` : undefined,
    'value' in step ? `value: ${quote(step.value)}` : undefined,
    step.action === 'upload' ? `filePath: ${quote(step.filePath)}` : undefined
  ].filter((line): line is string => Boolean(line));
  if (step.action === 'click') {
    return { methodName, rawText: step.rawText, usesAi: true, body: [
      `const candidates = await this.ai.observe(${quote(step.rawText)}, { variables: context });`,
      `const clicks = candidates.filter((candidate) => candidate.method === 'click');`,
      'const aiResult = clicks.length === 1',
      `  ? await this.ai.act({ ...clicks[0]!, description: ${quote(step.rawText)} }, { variables: context })`,
      `  : await this.ai.act({ ${values.join(', ')} });`,
      'if (!aiResult.success) throw new Error(aiResult.message);'
    ] };
  }
  return {
    methodName,
    rawText: step.rawText,
    body: [
      `const aiResult = await this.ai.act({ ${values.join(', ')} });`,
      `if (!aiResult.success) throw new Error(aiResult.message);`
    ],
    usesAi: true
  };
}

function aiActionForStep(action: ResolvedStep['step']['action']): string {
  switch (action) {
    case 'click':
      return 'click';
    case 'fill':
      return 'fill';
    case 'select':
      return 'selectOption';
    case 'upload':
      return 'setInputFiles';
    default:
      throw new Error(`CODEGEN_FAILED: unsupported AI act action ${action}`);
  }
}

function renderPrimitive(
  action: string,
  target: string,
  value: string,
  kb: CodegenKb,
  locator?: string
): string[] {
  if (action === 'wait') {
    return [`await this.page.waitForTimeout(${numberLiteral(value, 1000)});`];
  }

  if (action === 'scroll') {
    return [`await this.page.mouse.wheel(0, ${numberLiteral(value, 500)});`];
  }

  if (action === 'goto') {
    return [`await this.page.goto(${quote(target)});`];
  }

  if (action === 'navback') {
    return ['await this.page.goBack({ waitUntil: \'domcontentloaded\' });'];
  }

  if (action === 'keys') {
    return target === 'type'
      ? [`await this.page.keyboard.type(${quote(value)});`]
      : [`await this.page.keyboard.press(${quote(value || 'Enter')});`];
  }

  if (action === 'assertText' || action === 'assertVisible' || action === 'assertSemantic') {
    const kind = action === 'assertVisible' ? 'visible' : action === 'assertSemantic' ? 'semantic' : target.includes('列表') ? 'containsText' : 'text';
    return [`await this.ai.assert({ instruction: ${quote(`验证${target}${value ? `为${value}` : '可见'}`)}, target: ${quote(target)}, kind: ${quote(kind)}, expected: ${quote(value)}, variables: context });`];
  }

  const element = locator ? findElementByLocator(locator, target, kb.elements) : findElement(target, kb.elements);
  const resolvedLocator = locator ?? element?.locator_primary;
  if (!resolvedLocator) {
    throw new Error(`CODEGEN_FAILED: locator not found for target ${target}`);
  }

  const scoped = scopedLocatorExpression(resolvedLocator, target);

  if (action === 'fill') {
    return [`await ${scoped}.fill(${quote(value)});`, ...renderContextCapture(target, value)];
  }

  if (action === 'upload') {
    return [`await ${scoped}.setInputFiles(${quote(value)});`];
  }

  if (action === 'type') {
    return [`await ${scoped}.type(${quote(value)});`, ...renderContextCapture(target, value)];
  }

  if (action === 'press') {
    return [`await ${scoped}.press(${quote(value || 'Enter')});`];
  }

  if (action === 'select') {
    return [`await ${scoped}.selectOption({ label: ${quote(value)} });`];
  }

  if (action === 'selectOption' || action === 'selectOptionFromDropdown') {
    return [`await ${scoped}.selectOption({ label: ${quote(value)} });`];
  }

  if (action === 'click') {
    return [`await ${scoped}.click();`];
  }

  if (action === 'doubleClick') {
    return [`await ${scoped}.dblclick();`];
  }

  if (action === 'hover') {
    return [`await ${scoped}.hover();`];
  }

  if (action === 'scrollTo') {
    return [`await ${scoped}.scrollIntoViewIfNeeded();`];
  }

  if (action === 'nextChunk') {
    return ['await this.page.mouse.wheel(0, Math.round((this.page.viewportSize()?.height ?? 600) * 0.8));'];
  }

  if (action === 'prevChunk') {
    return ['await this.page.mouse.wheel(0, -Math.round((this.page.viewportSize()?.height ?? 600) * 0.8));'];
  }


  throw new Error(`CODEGEN_FAILED: unsupported action ${action}`);
}

function scopedLocatorExpression(locator: string, target: string): string {
  if (locator.startsWith('xpath=') || locator.startsWith('css=')) {
    return `this.page.locator(${quote(locator)})`;
  }

  if (locator.startsWith('//') || locator.startsWith('/')) {
    return `this.page.locator(${quote(`xpath=${locator}`)})`;
  }

  const rowScopedLocator = locator.match(/^page\.getByRole\((["'])row\1\)\.filter\(\{\s*hasText:\s*(["'])(.*?)\2\s*\}\)\.(.+)$/);
  if (rowScopedLocator?.[3] && rowScopedLocator[4]) {
    return `this.rowByText(${rowTextExpression(rowScopedLocator[3], target, rowScopedLocator[4])}).${rowScopedLocator[4]}`;
  }

  const rowScopedTestIds = new Set(['approve-order', 'order-status']);
  const productRowScopedTestIds = new Set(['product-more-button', 'product-offsale-menuitem', 'product-status']);
  const userRowScopedTestIds = new Set(['edit-user-button', 'user-status']);
  const testId = locator.match(/^page\.getByTestId\((["'])(.*?)\1\)$/)?.[2];
  if (testId && rowScopedTestIds.has(testId)) {
    return `this.orderRow(context.orderNo).getByTestId(${quote(testId)})`;
  }

  if (testId && productRowScopedTestIds.has(testId)) {
    return `this.rowByText(context.productName).getByTestId(${quote(testId)})`;
  }

  if (testId && userRowScopedTestIds.has(testId)) {
    return `this.rowByText(context.userName).getByTestId(${quote(testId)})`;
  }

  return locator.replace(/^page\./, 'this.page.');
}

function rowTextExpression(rowText: string, target: string, testId: string): string {
  if (rowText !== '${rowText}') {
    return quote(rowText);
  }

  if (target.includes('订单') || testId.includes('order')) {
    return 'context.orderNo';
  }

  if (target.includes('商品') || testId.includes('product')) {
    return 'context.productName';
  }

  if (target.includes('用户') || testId.includes('user')) {
    return 'context.userName';
  }

  return 'context.rowText';
}

function renderContextCapture(target: string, value: string): string[] {
  if (target.includes('订单编号')) {
    return [`context.orderNo = ${quote(value)};`];
  }

  if (target.includes('商品名称')) {
    return [`context.productName = ${quote(value)};`];
  }

  if (target === '姓名输入框' || target.includes('用户姓名') || target.includes('姓名')) {
    return [`context.userName = ${quote(value)};`];
  }

  return [];
}

function findElement(target: string, elements: ElementRow[]): ElementRow | undefined {
  const normalizedTarget = normalize(target);
  return (
    elements.find((element) => normalize(element.semantic_name) === normalizedTarget) ??
    elements.find((element) => normalize(element.semantic_name).includes(normalizedTarget))
  );
}

function findElementByLocator(locator: string, target: string, elements: ElementRow[]): ElementRow | undefined {
  const matches = elements.filter((element) => element.locator_primary === locator);
  return (
    matches.find((element) => normalize(element.semantic_name) === normalize(target)) ??
    matches[0]
  );
}

function interpolateLiteral(value: string, inputs?: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => inputs?.[key] ?? '');
}

function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/[「」"'`\s_-]+/g, '').replace(/元素$/g, '').replace(/控件$/g, '');
}

function quote(input: string): string {
  return JSON.stringify(input);
}

function numberLiteral(input: string, fallback: number): number {
  const value = Number(input);
  return Number.isFinite(value) ? value : fallback;
}

function toImportPath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/\.ts$/u, '.js');
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

function joinUrl(baseUrl: string, target: string): string {
  return new URL(target, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}
