import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { z } from 'zod';
import { loadConfig } from '../config/load-config.js';
import type { AiPwConfig } from '../config/schema.js';
import { ensureDir } from '../utils/fs.js';
import { ActionExecutor } from './action-executor.js';
import { AiRuntimeCache, redactVariableValues } from './cache.js';
import { AiRuntimeError, runtimeError } from './errors.js';
import {
  RuntimeModelClient,
  type ModelMessage,
  type ModelTool,
  type ModelToolCall
} from './model-client.js';
import { PageSnapshotter } from './snapshot.js';
import type {
  AiActionCandidate,
  AiActionMethod,
  AiActInput,
  AiActResult,
  AiAgentHistoryItem,
  AiAgentInput,
  AiAgentResult,
  AiAssertInput,
  AiAssertResult,
  AiExtractOptions,
  AiObserveOptions,
  ExtractSchema,
  LocatorDescriptor,
  PageSnapshot
} from './types.js';

const actionMethodSchema = z.enum([
  'click',
  'fill',
  'selectOption',
  'setInputFiles',
  'press',
  'hover',
  'doubleClick'
]);

const observeResponseSchema = z.object({
  candidates: z.array(z.object({
    elementId: z.string().min(1),
    description: z.string().min(1),
    method: actionMethodSchema,
    arguments: z.array(z.string()).default([]),
    confidence: z.number().min(0).max(1)
  })).max(20)
});

const actionPlanSchema = z.object({
  elementId: z.string().min(1),
  method: actionMethodSchema,
  arguments: z.array(z.string()).default([]),
  reasoning: z.string().default('')
});

const assertExtractSchema = z.object({
  visible: z.boolean(),
  enabled: z.boolean(),
  text: z.string(),
  value: z.string(),
  evidence: z.array(z.string()).default([])
});

const semanticJudgeSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()).default([])
});

type RuntimeModel = Pick<RuntimeModelClient, 'completeJson' | 'completeWithTools'>;

export type CreateAiRuntimeOptions = {
  cwd?: string;
  config?: AiPwConfig;
  model?: RuntimeModel;
};

export class AiRuntime {
  private configPromise?: Promise<AiPwConfig>;
  private snapshotter?: PageSnapshotter;
  private executor?: ActionExecutor;
  private model?: RuntimeModel;
  private cache?: AiRuntimeCache;

  constructor(
    private readonly page: Page,
    private readonly options: CreateAiRuntimeOptions = {}
  ) {}

  async observe(
    instruction: string,
    options: AiObserveOptions = {}
  ): Promise<AiActionCandidate[]> {
    const config = await this.config();
    const snapshot = await this.snapshot(options.selector);
    const response = await this.getModel(config).completeJson({
      purpose: 'observe',
      system: [
        'You inspect a browser accessibility/DOM snapshot.',
        'Return only elements relevant to the user instruction.',
        'Use only elementId values that appear in the snapshot.',
        'Choose a safe Playwright-style action method for each candidate.'
      ].join(' '),
      user: {
        instruction,
        variableNames: Object.keys(options.variables ?? {}),
        snapshot: snapshot.text
      },
      schema: observeResponseSchema,
      timeoutMs: options.timeoutMs
    });

    return response.candidates.flatMap((candidate) => {
      const node = snapshot.nodes.find((item) => item.elementId === candidate.elementId);
      const locator = node?.locators[0];
      if (!node || !locator) {
        return [];
      }
      return [{
        ...candidate,
        method: candidate.method as AiActionMethod,
        arguments: candidate.arguments ?? [],
        locator
      }];
    }).sort((a, b) => b.confidence - a.confidence);
  }

  async extract<T>(
    instruction: string,
    schema: ExtractSchema<T>,
    options: AiExtractOptions = {}
  ): Promise<T> {
    const config = await this.config();
    const snapshot = await this.snapshot(options.selector);
    return this.getModel(config).completeJson({
      purpose: 'extract',
      system: [
        'Extract structured facts from the supplied browser DOM/accessibility snapshot.',
        'Do not invent facts that are not present.',
        `The output must match this shape: ${describeSchema(schema)}.`
      ].join(' '),
      user: {
        instruction,
        context: options.context,
        snapshot: snapshot.text
      },
      schema,
      timeoutMs: options.timeoutMs
    });
  }

  async act(input: AiActInput): Promise<AiActResult> {
    const config = await this.config();
    const timeoutMs = input.timeoutMs ?? config.runtimeAi.timeoutMs;
    const firstSnapshot = await this.snapshot();
    const cache = this.getCache(config);
    const cacheInstruction = redactVariableValues(input.instruction, input.variables);
    const key = cache.createKey({
      instruction: input.instruction,
      url: firstSnapshot.url,
      pageFingerprint: firstSnapshot.fingerprint,
      model: config.runtimeAi.model ?? config.ai.model,
      variables: input.variables
    });
    const cached = await cache.get(key);

    if (
      cached &&
      (!input.action || cached.action === input.action) &&
      await this.getExecutor().isUsable(cached.locator)
    ) {
      try {
        await this.getExecutor().execute({
          method: cached.action,
          locator: cached.locator,
          value: input.value,
          filePath: input.filePath,
          timeoutMs
        });
        const result: AiActResult = {
          success: true,
          action: cached.action,
          locator: cached.locator,
          fromCache: true,
          selfHealed: false
        };
        await this.tryArtifact('act', { input, result });
        return result;
      } catch {
        // A fresh snapshot and model plan below provide one self-healing attempt.
      }
    }

    try {
      const result = await this.planAndExecute(input, firstSnapshot, timeoutMs);
      await cache.set({
        key,
        instruction: cacheInstruction,
        url: firstSnapshot.url,
        pageFingerprint: firstSnapshot.fingerprint,
        model: config.runtimeAi.model ?? config.ai.model,
        variableNames: Object.keys(input.variables ?? {}).sort(),
        action: result.action,
        locator: result.locator
      }).catch(() => undefined);
      await this.tryArtifact('act', { input, result });
      return result;
    } catch (firstError) {
      if (!config.runtimeAi.selfHeal) {
        throw this.wrapActError(firstError);
      }
      try {
        const freshSnapshot = await this.snapshot();
        const result = await this.planAndExecute(input, freshSnapshot, timeoutMs);
        const healed = { ...result, selfHealed: true };
        await cache.set({
          key,
          instruction: cacheInstruction,
          url: freshSnapshot.url,
          pageFingerprint: freshSnapshot.fingerprint,
          model: config.runtimeAi.model ?? config.ai.model,
          variableNames: Object.keys(input.variables ?? {}).sort(),
          action: healed.action,
          locator: healed.locator
        }).catch(() => undefined);
        await this.tryArtifact('act', { input, result: healed });
        return healed;
      } catch (secondError) {
        const error = this.wrapActError(secondError, firstError);
        await this.tryArtifact('act-failed', { input, error: error.message });
        throw error;
      }
    }
  }

  async assert(input: AiAssertInput): Promise<AiAssertResult> {
    const candidates = await this.observe(input.instruction, {
      timeoutMs: input.timeoutMs,
      variables: input.variables
    });
    const candidate = candidates[0];
    const extracted = await this.extract(input.instruction, assertExtractSchema, {
      timeoutMs: input.timeoutMs,
      context: candidate
        ? `Observed candidate: ${candidate.description}; locator strategy=${candidate.locator.strategy}`
        : 'No matching element was observed; evaluate page-level evidence only.'
    });
    const deterministicFacts = candidate
      ? await this.getExecutor().facts(candidate.locator)
      : { visible: false, enabled: false, text: '', value: '' };
    const facts = {
      ...extracted,
      ...deterministicFacts,
      evidence: [
        ...(extracted.evidence ?? []),
        candidate ? `candidate=${candidate.description}` : 'no matching candidate'
      ]
    };

    let passed: boolean;
    let reason: string;
    let evidence = facts.evidence;
    switch (input.kind) {
      case 'visible':
        passed = facts.visible;
        reason = passed ? 'target is visible' : 'target is not visible';
        break;
      case 'hidden':
        passed = !facts.visible;
        reason = passed ? 'target is hidden' : 'target is visible';
        break;
      case 'enabled':
        passed = facts.visible && facts.enabled;
        reason = passed ? 'target is enabled' : 'target is not enabled';
        break;
      case 'disabled':
        passed = facts.visible && !facts.enabled;
        reason = passed ? 'target is disabled' : 'target is not disabled';
        break;
      case 'text':
        passed = facts.text.trim() === (input.expected ?? '').trim();
        reason = passed ? 'text equals expected value' : 'text does not equal expected value';
        break;
      case 'containsText':
        passed = facts.text.includes(input.expected ?? '');
        reason = passed ? 'text contains expected value' : 'text does not contain expected value';
        break;
      case 'semantic': {
        const config = await this.config();
        const judgement = await this.getModel(config).completeJson({
          purpose: 'assert',
          system: 'Judge whether the browser facts satisfy the assertion. Do not infer missing evidence.',
          user: { assertion: input.instruction, expected: input.expected, facts },
          schema: semanticJudgeSchema,
          timeoutMs: input.timeoutMs
        });
        passed = judgement.passed;
        reason = judgement.reason;
        evidence = [...evidence, ...(judgement.evidence ?? [])];
        break;
      }
    }

    if (!passed) {
      const details = {
        instruction: input.instruction,
        kind: input.kind,
        expected: input.expected,
        actual: facts,
        evidence,
        reason
      };
      const artifactPath = await this.tryArtifact('assert-failed', details);
      throw runtimeError('AI_ASSERT_FAILED', `${reason}; artifact=${artifactPath}`, details);
    }

    const result: AiAssertResult = {
      passed: true,
      actual: facts,
      evidence,
      reason
    };
    await this.tryArtifact('assert', { input, result });
    return result;
  }

  async agent(input: AiAgentInput): Promise<AiAgentResult> {
    const config = await this.config();
    const maxSteps = input.maxSteps ?? config.runtimeAi.agent.maxSteps;
    const totalTimeoutMs = input.timeoutMs ?? config.runtimeAi.agent.timeoutMs;
    const deadline = Date.now() + totalTimeoutMs;
    const history: AiAgentHistoryItem[] = [];
    const messages: ModelMessage[] = [
      {
        role: 'system',
        content: [
          'You are a bounded browser automation agent operating an existing Playwright page.',
          'Use the supplied tools only. Begin by observing when the target is not certain.',
          'Never claim success without verifying the final state.',
          'Call done exactly once when the goal is complete or impossible.'
        ].join(' ')
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal: input.instruction,
          variableNames: Object.keys(input.variables ?? {}),
          currentUrl: this.page.url()
        })
      }
    ];

    for (let step = 1; step <= maxSteps; step += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw runtimeError('AI_AGENT_FAILED', `agent exceeded total timeout of ${totalTimeoutMs}ms`, { history });
      }
      const decisionSnapshot = await this.snapshot();
      const cache = this.getCache(config);
      const decisionKey = cache.createKey({
        instruction: [
          'agent-decision',
          input.instruction,
          `step=${step}`,
          `history=${history.map((item) => item.tool).join(',')}`
        ].join('\n'),
        url: decisionSnapshot.url,
        pageFingerprint: decisionSnapshot.fingerprint,
        model: config.runtimeAi.model ?? config.ai.model,
        variables: input.variables
      });
      const cachedDecision = await cache.getAgentDecision(decisionKey);
      const response = cachedDecision
        ? {
            content: null,
            toolCalls: transformToolCallVariables(
              cachedDecision.toolCalls,
              input.variables,
              'hydrate'
            )
          }
        : await this.getModel(config).completeWithTools(
            messages,
            agentTools,
            Math.min(remaining, config.runtimeAi.agent.toolTimeoutMs)
          );
      const decisionFromCache = Boolean(cachedDecision);
      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls
      });

      if (response.toolCalls.length === 0) {
        throw runtimeError(
          'AI_MODEL_CAPABILITY_UNSUPPORTED',
          'agent model returned text without calling a tool'
        );
      }

      for (const call of response.toolCalls) {
        const toolInput = parseToolArguments(call);
        let output: unknown;
        try {
          output = call.function.name === 'done' &&
            Boolean(toolInput.success) &&
            !hasVerificationAfterLastMutation(history)
            ? { success: false, message: 'Agent must verify the final state before reporting success' }
            : await withTimeout(
                this.executeAgentTool(call.function.name, toolInput, input, config),
                Math.min(deadline - Date.now(), config.runtimeAi.agent.toolTimeoutMs),
                call.function.name
              );
        } catch (error) {
          if (!decisionFromCache) {
            throw error;
          }
          await cache.deleteAgentDecision(decisionKey);
          output = {
            cachedDecisionFailed: true,
            error: error instanceof Error ? error.message : String(error)
          };
        }
        history.push({ step, tool: call.function.name, input: safeValue(toolInput), output });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(output)
        });
        const failedDone = call.function.name === 'done' &&
          output &&
          typeof output === 'object' &&
          'success' in output &&
          output.success === false;
        if (!decisionFromCache && response.toolCalls.length === 1 && !failedDone) {
          await cache.setAgentDecision({
            key: decisionKey,
            toolCalls: transformToolCallVariables(
              response.toolCalls,
              input.variables,
              'template'
            )
          }).catch(() => undefined);
        }

        if (
          output &&
          typeof output === 'object' &&
          'cachedDecisionFailed' in output
        ) {
          break;
        }

        if (call.function.name === 'done') {
          const done = output as { success: boolean; message: string };
          if (!done.success) {
            const artifactPath = await this.tryArtifact('agent-failed', { input, history, message: done.message });
            throw runtimeError('AI_AGENT_FAILED', `${done.message}; artifact=${artifactPath}`, { history });
          }
          const result: AiAgentResult = {
            success: true,
            message: done.message,
            steps: step,
            history
          };
          await this.tryArtifact('agent', { input, result });
          return result;
        }
      }
    }

    const artifactPath = await this.tryArtifact('agent-failed', { input, history, reason: 'max steps reached' });
    throw runtimeError(
      'AI_AGENT_FAILED',
      `agent reached maximum steps (${maxSteps}); artifact=${artifactPath}`,
      { history }
    );
  }

  async close(): Promise<void> {
    await this.snapshotter?.close();
  }

  private async planAndExecute(
    input: AiActInput,
    snapshot: PageSnapshot,
    timeoutMs: number
  ): Promise<AiActResult> {
    const config = await this.config();
    const plan = await this.getModel(config).completeJson({
      purpose: 'act',
      system: [
        'Choose one element and one safe browser action from the DOM/accessibility snapshot.',
        'Use an elementId that appears in the snapshot.',
        input.action ? `The method must be ${input.action}.` : '',
        'Do not invent user values or file paths.'
      ].filter(Boolean).join(' '),
      user: {
        instruction: input.instruction,
        requestedAction: input.action,
        target: input.target,
        hasValue: input.value !== undefined,
        hasFilePath: input.filePath !== undefined,
        variableNames: Object.keys(input.variables ?? {}),
        snapshot: snapshot.text
      },
      schema: actionPlanSchema,
      timeoutMs
    });
    const node = snapshot.nodes.find((item) => item.elementId === plan.elementId);
    const locator = node?.locators[0];
    if (!node || !locator) {
      throw runtimeError('AI_ACT_FAILED', `model selected unknown or unlocatable element ${plan.elementId}`);
    }
    const action = input.action ?? plan.method;
    if (input.action && plan.method !== input.action) {
      throw runtimeError(
        'AI_ACT_FAILED',
        `model returned method ${plan.method}, expected ${input.action}`
      );
    }
    await this.getExecutor().execute({
      method: action,
      locator,
      value: input.value ?? plan.arguments?.[0],
      filePath: input.filePath,
      timeoutMs
    });
    return {
      success: true,
      action,
      locator,
      fromCache: false,
      selfHealed: false
    };
  }

  private async executeAgentTool(
    name: string,
    input: Record<string, unknown>,
    agentInput: AiAgentInput,
    config: AiPwConfig
  ): Promise<unknown> {
    switch (name) {
      case 'observe':
        return this.observe(requiredString(input, 'instruction'), {
          variables: agentInput.variables
        });
      case 'act':
      {
        const value = optionalString(input.value);
        return this.act({
          instruction: requiredString(input, 'instruction'),
          action: optionalAction(input.action),
          target: optionalString(input.target),
          value: value === undefined ? undefined : interpolateVariables(value, agentInput.variables),
          variables: agentInput.variables
        });
      }
      case 'assert':
        return this.assert({
          instruction: requiredString(input, 'instruction'),
          kind: z.enum(['visible', 'hidden', 'text', 'containsText', 'enabled', 'disabled', 'semantic'])
            .parse(input.kind),
          target: optionalString(input.target),
          expected: optionalString(input.expected),
          variables: agentInput.variables
        });
      case 'extract':
        return this.extract(
          requiredString(input, 'instruction'),
          z.object({ summary: z.string(), evidence: z.array(z.string()).default([]) })
        );
      case 'fillForm': {
        const fields = z.array(z.object({
          target: z.string().min(1),
          value: z.string()
        })).parse(input.fields);
        const results = [];
        for (const field of fields) {
          results.push(await this.act({
            instruction: `Fill ${field.target}`,
            action: 'fill',
            target: field.target,
            value: interpolateVariables(field.value, agentInput.variables),
            variables: agentInput.variables
          }));
        }
        return results;
      }
      case 'goto': {
        const target = new URL(requiredString(input, 'url'), this.page.url() || config.baseUrl);
        const currentUrl = this.page.url();
        const allowedOrigin = /^https?:/u.test(currentUrl)
          ? new URL(currentUrl).origin
          : new URL(config.baseUrl).origin;
        if (config.runtimeAi.agent.sameOriginOnly && target.origin !== allowedOrigin) {
          throw runtimeError('AI_AGENT_FAILED', `cross-origin navigation is blocked: ${target.origin}`);
        }
        await this.page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
        return { url: this.page.url() };
      }
      case 'scroll': {
        const direction = z.enum(['up', 'down']).parse(input.direction);
        const amount = typeof input.amount === 'number' ? input.amount : 600;
        await this.page.mouse.wheel(0, direction === 'down' ? amount : -amount);
        return { direction, amount };
      }
      case 'pressKey': {
        const key = requiredString(input, 'key');
        await this.page.keyboard.press(key);
        return { key };
      }
      case 'goBack':
        await this.page.goBack({ waitUntil: 'domcontentloaded' });
        return { url: this.page.url() };
      case 'wait': {
        const ms = Math.min(typeof input.ms === 'number' ? input.ms : 1000, 10000);
        await this.page.waitForTimeout(ms);
        return { ms };
      }
      case 'screenshot': {
        const outputPath = await this.artifactPath('agent-screenshot', 'png');
        await this.page.screenshot({ path: outputPath, fullPage: false });
        return { path: outputPath };
      }
      case 'think':
        return { noted: requiredString(input, 'thought') };
      case 'done':
        return {
          success: Boolean(input.success),
          message: requiredString(input, 'message')
        };
      default:
        throw runtimeError('AI_AGENT_FAILED', `unsupported agent tool: ${name}`);
    }
  }

  private async config(): Promise<AiPwConfig> {
    this.configPromise ??= this.options.config
      ? Promise.resolve(this.options.config)
      : loadConfig(this.options.cwd ?? process.cwd());
    const config = await this.configPromise;
    if (!config.runtimeAi.enabled) {
      throw runtimeError('AI_RUNTIME_DISABLED', 'runtimeAi.enabled is false');
    }
    return config;
  }

  private async snapshot(selector?: string): Promise<PageSnapshot> {
    const config = await this.config();
    this.snapshotter ??= new PageSnapshotter(this.page, config.runtimeAi.snapshotMaxChars);
    return this.snapshotter.capture(selector);
  }

  private getExecutor(): ActionExecutor {
    this.executor ??= new ActionExecutor(this.page);
    return this.executor;
  }

  private getModel(config: AiPwConfig): RuntimeModel {
    this.model ??= this.options.model ?? new RuntimeModelClient(config);
    return this.model;
  }

  private getCache(config: AiPwConfig): AiRuntimeCache {
    this.cache ??= new AiRuntimeCache(path.resolve(
      this.options.cwd ?? process.cwd(),
      config.runtimeAi.cacheDir
    ));
    return this.cache;
  }

  private wrapActError(error: unknown, previous?: unknown): AiRuntimeError {
    if (error instanceof AiRuntimeError && error.code === 'AI_ACT_FAILED') {
      return error;
    }
    return runtimeError('AI_ACT_FAILED', error instanceof Error ? error.message : String(error), {
      previous: previous instanceof Error ? previous.message : previous
    });
  }

  private async artifact(kind: string, value: unknown): Promise<string> {
    const filePath = await this.artifactPath(kind, 'json');
    await writeFile(filePath, `${JSON.stringify(safeValue(value), null, 2)}\n`, 'utf8');
    return filePath;
  }

  private async tryArtifact(kind: string, value: unknown): Promise<string> {
    try {
      return await this.artifact(kind, value);
    } catch {
      return 'artifact-unavailable';
    }
  }

  private async artifactPath(kind: string, extension: 'json' | 'png'): Promise<string> {
    const config = await this.config();
    const directory = path.resolve(
      this.options.cwd ?? process.cwd(),
      config.runtimeAi.artifactsDir
    );
    await ensureDir(directory);
    return path.join(
      directory,
      `${kind}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${Math.random().toString(36).slice(2, 8)}.${extension}`
    );
  }
}

export function createAiRuntime(page: Page, options: CreateAiRuntimeOptions = {}): AiRuntime {
  return new AiRuntime(page, options);
}

const agentTools: ModelTool[] = [
  tool('observe', 'Find relevant elements in the current page', {
    instruction: stringProperty()
  }, ['instruction']),
  tool('act', 'Perform one browser action on one element', {
    instruction: stringProperty(),
    action: { type: 'string', enum: actionMethodSchema.options },
    target: stringProperty(),
    value: stringProperty()
  }, ['instruction']),
  tool('assert', 'Verify the current browser state', {
    instruction: stringProperty(),
    kind: {
      type: 'string',
      enum: ['visible', 'hidden', 'text', 'containsText', 'enabled', 'disabled', 'semantic']
    },
    target: stringProperty(),
    expected: stringProperty()
  }, ['instruction', 'kind']),
  tool('extract', 'Extract a concise fact summary from the page', {
    instruction: stringProperty()
  }, ['instruction']),
  tool('fillForm', 'Fill several form fields', {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: stringProperty(),
          value: stringProperty()
        },
        required: ['target', 'value'],
        additionalProperties: false
      }
    }
  }, ['fields']),
  tool('goto', 'Navigate to a same-origin URL', { url: stringProperty() }, ['url']),
  tool('scroll', 'Scroll the current page', {
    direction: { type: 'string', enum: ['up', 'down'] },
    amount: { type: 'number' }
  }, ['direction']),
  tool('pressKey', 'Press a keyboard key or chord', { key: stringProperty() }, ['key']),
  tool('goBack', 'Navigate back one page', {}, []),
  tool('wait', 'Wait briefly for asynchronous UI updates', { ms: { type: 'number' } }, ['ms']),
  tool('screenshot', 'Save a screenshot for later diagnostics', {}, []),
  tool('think', 'Record concise planning without changing the page', { thought: stringProperty() }, ['thought']),
  tool('done', 'Finish the agent run', {
    success: { type: 'boolean' },
    message: stringProperty()
  }, ['success', 'message'])
];

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[]
): ModelTool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties,
        required,
        additionalProperties: false
      }
    }
  };
}

function stringProperty(): Record<string, unknown> {
  return { type: 'string' };
}

function parseToolArguments(call: ModelToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments);
    return z.record(z.unknown()).parse(parsed);
  } catch (error) {
    throw runtimeError(
      'AI_MODEL_INVALID_RESPONSE',
      `invalid arguments for tool ${call.function.name}`,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function requiredString(input: Record<string, unknown>, key: string): string {
  return z.string().min(1).parse(input[key]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalAction(value: unknown): AiActionMethod | undefined {
  return value === undefined ? undefined : actionMethodSchema.parse(value);
}

function interpolateVariables(value: string, variables?: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/gu, (_, key: string) => variables?.[key] ?? '');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) {
    throw runtimeError('AI_RUNTIME_TIMEOUT', `${label} timed out`);
  }
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(runtimeError('AI_RUNTIME_TIMEOUT', `${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function describeSchema(schema: z.ZodTypeAny): string {
  const definition = schema._def as { typeName?: string; shape?: () => Record<string, z.ZodTypeAny>; type?: z.ZodTypeAny; innerType?: z.ZodTypeAny; values?: string[] };
  switch (definition.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject:
      return `{ ${Object.entries(definition.shape?.() ?? {}).map(([key, value]) => `${key}: ${describeSchema(value)}`).join(', ')} }`;
    case z.ZodFirstPartyTypeKind.ZodArray:
      return `Array<${definition.type ? describeSchema(definition.type) : 'unknown'}>`;
    case z.ZodFirstPartyTypeKind.ZodString:
      return 'string';
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return 'number';
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return 'boolean';
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return (definition.values ?? []).map((value) => JSON.stringify(value)).join(' | ');
    case z.ZodFirstPartyTypeKind.ZodOptional:
      return `${definition.innerType ? describeSchema(definition.innerType) : 'unknown'} | undefined`;
    case z.ZodFirstPartyTypeKind.ZodNullable:
      return `${definition.innerType ? describeSchema(definition.innerType) : 'unknown'} | null`;
    case z.ZodFirstPartyTypeKind.ZodDefault:
      return definition.innerType ? describeSchema(definition.innerType) : 'unknown';
    default:
      return 'JSON value';
  }
}

function safeValue(value: unknown, key = ''): unknown {
  if (/(password|token|secret|api.?key)/iu.test(key)) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        childKey === 'variables' && childValue && typeof childValue === 'object'
          ? Object.keys(childValue as Record<string, unknown>)
          : safeValue(childValue, childKey)
      ])
    );
  }
  return value;
}

function hasVerificationAfterLastMutation(history: AiAgentHistoryItem[]): boolean {
  const verificationTools = new Set(['observe', 'assert', 'extract']);
  const mutationTools = new Set([
    'act',
    'fillForm',
    'goto',
    'scroll',
    'pressKey',
    'goBack',
    'wait'
  ]);
  let lastVerification = -1;
  let lastMutation = -1;
  for (const [index, item] of history.entries()) {
    if (verificationTools.has(item.tool)) {
      lastVerification = index;
    }
    if (mutationTools.has(item.tool)) {
      lastMutation = index;
    }
  }
  return lastVerification > lastMutation;
}

function transformToolCallVariables(
  calls: ModelToolCall[],
  variables: Record<string, string> | undefined,
  mode: 'template' | 'hydrate'
): ModelToolCall[] {
  return calls.map((call) => {
    try {
      const parsed = JSON.parse(call.function.arguments);
      const transformed = transformVariables(parsed, variables, mode);
      return {
        ...call,
        function: {
          ...call.function,
          arguments: JSON.stringify(transformed)
        }
      };
    } catch {
      return call;
    }
  });
}

function transformVariables(
  value: unknown,
  variables: Record<string, string> | undefined,
  mode: 'template' | 'hydrate'
): unknown {
  if (typeof value === 'string') {
    if (mode === 'template') {
      return redactVariableValues(value, variables);
    }
    return value.replace(/\$\{([^}]+)\}/gu, (_, key: string) => variables?.[key] ?? '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => transformVariables(item, variables, mode));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        transformVariables(child, variables, mode)
      ])
    );
  }
  return value;
}
