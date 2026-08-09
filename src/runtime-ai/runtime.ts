import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  ToolLoopAgent,
  hasToolCall,
  stepCountIs,
  tool as aiTool,
  type ModelMessage,
  type StepResult,
  type ToolSet
} from 'ai';
import { z } from 'zod';
import { loadConfig } from '../config/load-config.js';
import type { VoleConfig } from '../config/schema.js';
import { runtimeLogger } from '../logging/context.js';
import { hashSensitiveText, type VoleLogger } from '../logging/logger.js';
import { waitForDomNetworkQuiet, waitForPageReady } from '../playwright/page-readiness.js';
import { ensureDir } from '../utils/fs.js';
import { ActionExecutor, SUPPORTED_ACTIONS } from './action-executor.js';
import { AiRuntimeCache, redactVariableValues } from './cache.js';
import { AiRuntimeError, isCancellation, runtimeError } from './errors.js';
import {
  RuntimeModelClient,
  type ModelObjectResult
} from './model-client.js';
import { PageSnapshotter } from './snapshot.js';
import {
  substituteVariables,
  variablePromptEntries
} from './variables.js';
import type {
  AiActionCandidate,
  AiAction,
  AiActionMethod,
  AiActInput,
  AiActOptions,
  AiActResult,
  AiAgentConfig,
  AiAgentExecuteOptions,
  AiAgentHistoryItem,
  AiAgentInput,
  AiAgentInstance,
  AiAgentResult,
  AiStreamingAgentInstance,
  AiAssertInput,
  AiAssertResult,
  AiExtractOptions,
  AiExtractCompleteness,
  AiObserveOptions,
  AiVariables,
  ExtractSchema,
  LocatorDescriptor,
  PageSnapshot,
  SnapshotNode,
  ToolKind
} from './types.js';

/**
 * The subset of ACTION_METHODS the model may choose from during act/observe
 * inference. Both the validation schema and the prompt text derive from this
 * tuple so they cannot drift apart. Methods that need caller-supplied data
 * (e.g. setInputFiles) or are low-level primitives are intentionally excluded
 * and reached only via deterministic AiAction input.
 */
const INFERENCE_ACTION_METHODS = [
  'click',
  'fill',
  'type',
  'selectOptionFromDropdown',
  'press',
  'hover',
  'doubleClick',
  'scrollTo',
  'nextChunk',
  'prevChunk',
  'dragAndDrop'
] as const satisfies readonly AiActionMethod[];

const actionMethodSchema = z.enum(INFERENCE_ACTION_METHODS);

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
  action: z.object({
    elementId: z.string().regex(/^\d+-\d+$/u),
    description: z.string().min(1),
    method: actionMethodSchema,
    arguments: z.array(z.string())
  }).nullable(),
  twoStep: z.boolean()
});

const assertExtractSchema = z.object({
  visible: z.boolean(),
  enabled: z.boolean(),
  text: z.string(),
  value: z.string(),
  evidence: z.array(z.string()).default([])
});

const extractCompletenessSchema = z.object({
  completed: z.boolean(),
  missing: z.array(z.string()).default([]),
  reason: z.string().default('')
});

const semanticJudgeSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  evidence: z.array(z.string()).default([])
});

type RuntimeModel = Pick<RuntimeModelClient, 'completeJson' | 'completeWithTools'> &
  Partial<Pick<RuntimeModelClient, 'generateObject' | 'generateText' | 'getLanguageModel'>>;

export type CreateAiRuntimeOptions = {
  cwd?: string;
  config?: VoleConfig;
  model?: RuntimeModel;
  logger?: VoleLogger;
};

export class AiRuntime {
  private configPromise?: Promise<VoleConfig>;
  private snapshotter?: PageSnapshotter;
  private executor?: ActionExecutor;
  private model?: RuntimeModel;
  private cache?: AiRuntimeCache;
  private latestSnapshot?: PageSnapshot;
  private readonly logger: VoleLogger;

  constructor(
    private readonly page: Page,
    private readonly options: CreateAiRuntimeOptions = {}
  ) {
    this.logger = runtimeLogger(options.logger).child({ component: 'runtime-ai' });
  }

  async observe(): Promise<AiActionCandidate[]>;
  async observe(options: AiObserveOptions): Promise<AiActionCandidate[]>;
  async observe(instruction: string, options?: AiObserveOptions): Promise<AiActionCandidate[]>;
  async observe(
    instructionOrOptions?: string | AiObserveOptions,
    suppliedOptions: AiObserveOptions = {}
  ): Promise<AiActionCandidate[]> {
    const instruction = typeof instructionOrOptions === 'string'
      ? instructionOrOptions
      : 'List the most relevant interactive elements and safe actions on the current page.';
    const options = typeof instructionOrOptions === 'string'
      ? suppliedOptions
      : instructionOrOptions ?? {};
    const startedAt = Date.now();
    this.logger.info('ai.observe_started', {
      instructionHash: hashSensitiveText(instruction),
      instructionLength: instruction.length
    });
    const config = await this.config();
    const snapshot = await this.snapshot(options.selector, options.ignoreSelectors);
    const response = await this.completeObject<z.infer<typeof observeResponseSchema>>(config, {
      purpose: 'observe',
      system: [
        'You inspect a browser accessibility/DOM snapshot.',
        'Return only elements relevant to the user instruction.',
        'Use only elementId values that appear in the snapshot.',
        'Choose a safe Playwright-style action method for each candidate.'
      ].join(' '),
      user: {
        instruction,
        variables: variablePromptEntries(options.variables).map(({ name, description }) => ({
          placeholder: `%${name}%`,
          description
        })),
        snapshot: snapshot.text
      },
      schema: observeResponseSchema,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
      providerOptions: options.providerOptions,
      model: options.model
    });

    const candidates = response.value.candidates.flatMap((candidate) => {
      const node = actionableSnapshotNode(snapshot, candidate.elementId);
      const locator = node?.locators[0];
      if (!node || !locator) {
        return [];
      }
      const argumentsWithResolvedTargets = candidate.method === 'dragAndDrop' &&
        candidate.arguments?.[0]
        ? (() => {
            const target = actionableSnapshotNode(snapshot, candidate.arguments[0]);
            const targetLocator = target?.locators[0];
            return targetLocator
              ? [this.getExecutor().selector(targetLocator), ...candidate.arguments.slice(1)]
              : undefined;
          })()
        : candidate.arguments ?? [];
      if (!argumentsWithResolvedTargets) {
        return [];
      }
      return [{
        ...candidate,
        method: candidate.method as AiActionMethod,
        arguments: argumentsWithResolvedTargets,
        locator,
        selector: this.getExecutor().selector(locator)
      }];
    }).sort((a, b) => b.confidence - a.confidence);
    Object.defineProperty(candidates, 'cacheStatus', {
      value: 'MISS',
      enumerable: false
    });
    Object.defineProperty(candidates, 'usage', {
      value: response.usage,
      enumerable: false
    });
    this.logger.info('ai.observe_completed', {
      candidateCount: candidates.length,
      durationMs: Date.now() - startedAt
    });
    return candidates;
  }

  async extract(): Promise<{ pageText: string }>;
  async extract(options: AiExtractOptions): Promise<{ pageText: string }>;
  async extract(instruction: string, options?: AiExtractOptions): Promise<{ extraction: string }>;
  async extract<T>(
    instruction: string,
    schema: ExtractSchema<T>,
    options?: AiExtractOptions
  ): Promise<T>;
  async extract<T>(
    instructionOrOptions?: string | AiExtractOptions,
    schemaOrOptions?: ExtractSchema<T> | AiExtractOptions,
    suppliedOptions: AiExtractOptions = {}
  ): Promise<T | { pageText: string } | { extraction: string }> {
    const instruction = typeof instructionOrOptions === 'string'
      ? instructionOrOptions
      : undefined;
    const schema: ExtractSchema<T> | z.ZodType<{ extraction: string }> | undefined = isZodSchema(schemaOrOptions)
      ? schemaOrOptions
      : instruction
        ? z.object({ extraction: z.string() })
        : undefined;
    const options: AiExtractOptions = typeof instructionOrOptions === 'object'
      ? instructionOrOptions
      : isZodSchema(schemaOrOptions)
        ? suppliedOptions
        : (schemaOrOptions as AiExtractOptions | undefined) ?? {};
    const startedAt = Date.now();
    this.logger.info('ai.extract_started', {
      instructionHash: instruction ? hashSensitiveText(instruction) : undefined,
      instructionLength: instruction?.length ?? 0,
      structured: Boolean(schema),
      screenshot: options.screenshot === true
    });
    const config = await this.config();
    const snapshot = await this.snapshot(options.selector, options.ignoreSelectors);
    if (!instruction || !schema) {
      this.logger.info('ai.extract_completed', {
        structured: false,
        durationMs: Date.now() - startedAt
      });
      return { pageText: snapshot.text };
    }
    const screenshot = options.screenshot
      ? await this.page.screenshot({ fullPage: false, type: 'png' })
      : undefined;
    const transformedSchema = transformUrlSchema(schema as z.ZodTypeAny);
    const response = await this.completeObject<unknown>(config, {
      purpose: 'extract',
      system: [
        'Extract structured facts from the supplied browser DOM/accessibility snapshot.',
        'Do not invent facts that are not present.',
        `The output must match this shape: ${describeSchema(schema)}.`
      ].join(' '),
      user: {
        instruction,
        context: options.context,
        snapshot: snapshot.text,
        urlElementIds: Object.keys(snapshot.urlMap)
      },
      schema: transformedSchema.schema as z.ZodType<unknown>,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
      providerOptions: options.providerOptions,
      model: options.model,
      image: screenshot
        ? { data: new Uint8Array(screenshot), mediaType: 'image/png' }
        : undefined
    });
    let value = restoreUrlFields(
      response.value,
      transformedSchema.urlPaths,
      snapshot.urlMap,
      snapshot.url
    );
    let completeness: AiExtractCompleteness | undefined;
    if (options.verifyCompleteness) {
      const judge = await this.verifyExtractCompleteness(config, instruction, snapshot, options, value);
      let refined = false;
      if (!judge.completed && options.refineOnIncomplete) {
        const refineResponse = await this.completeObject<unknown>(config, {
          purpose: 'extract-refine',
          system: [
            'Extract structured facts from the supplied browser DOM/accessibility snapshot.',
            'Do not invent facts that are not present.',
            `The output must match this shape: ${describeSchema(schema)}.`
          ].join(' '),
          user: {
            instruction,
            context: [options.context, judge.missing.length ? `Previously missing: ${judge.missing.join(', ')}` : undefined]
              .filter((part): part is string => Boolean(part))
              .join('\n') || undefined,
            snapshot: snapshot.text,
            urlElementIds: Object.keys(snapshot.urlMap)
          },
          schema: transformedSchema.schema as z.ZodType<unknown>,
          timeoutMs: options.timeoutMs,
          abortSignal: options.abortSignal,
          providerOptions: options.providerOptions,
          model: options.model
        });
        value = restoreUrlFields(
          refineResponse.value,
          transformedSchema.urlPaths,
          snapshot.urlMap,
          snapshot.url
        );
        refined = true;
      }
      completeness = { completed: judge.completed, missing: judge.missing, refined };
    }
    this.logger.info('ai.extract_completed', {
      structured: true,
      completeness: completeness?.completed,
      refined: completeness?.refined,
      durationMs: Date.now() - startedAt
    });
    return attachResultMetadata(value, response.usage, completeness) as T;
  }

  private async verifyExtractCompleteness(
    config: VoleConfig,
    instruction: string,
    snapshot: PageSnapshot,
    options: AiExtractOptions,
    extracted: unknown
  ): Promise<{ completed: boolean; missing: string[]; reason: string }> {
    const response = await this.completeObject<{ completed: boolean; missing: string[]; reason: string }>(config, {
      purpose: 'extract-completeness',
      system: [
        'Judge whether the extracted data fully satisfies the instruction against the supplied browser snapshot.',
        'Return completed=true only if nothing relevant is missing.',
        'When incomplete, list the specific missing fields or facts in `missing`.'
      ].join(' '),
      user: { instruction, extracted, snapshot: snapshot.text },
      schema: extractCompletenessSchema,
      timeoutMs: options.timeoutMs,
      abortSignal: options.abortSignal,
      providerOptions: options.providerOptions,
      model: options.model
    });
    return response.value;
  }

  async act(input: AiActInput): Promise<AiActResult>;
  async act(input: string, options?: AiActOptions): Promise<AiActResult>;
  async act(input: AiAction, options?: AiActOptions): Promise<AiActResult>;
  async act(
    rawInput: AiActInput | string | AiAction,
    options: AiActOptions = {}
  ): Promise<AiActResult> {
    if (isAiAction(rawInput)) {
      const config = await this.config();
      const deadline = createActDeadline(options.timeoutMs ?? config.runtimeAi.timeoutMs);
      const startedAt = Date.now();
      this.logger.info('ai.act_started', {
        deterministic: true,
        method: rawInput.method,
        descriptionHash: hashSensitiveText(rawInput.description)
      });
      const result = await this.takeDeterministicAction(rawInput, options, deadline);
      this.logger.info('ai.act_completed', {
        success: result.success,
        deterministic: true,
        method: result.action,
        durationMs: Date.now() - startedAt
      });
      return result;
    }
    if (
      (typeof rawInput === 'string' && !rawInput.trim()) ||
      (typeof rawInput === 'object' && !rawInput.instruction?.trim())
    ) {
      throw runtimeError(
        'AI_ACT_FAILED',
        'act(): instruction string is required unless passing an Action'
      );
    }
    const input: AiActInput = typeof rawInput === 'string'
      ? {
          instruction: rawInput,
          variables: options.variables,
          timeoutMs: options.timeoutMs,
          model: options.model,
          cache: options.cache,
          abortSignal: options.abortSignal,
          providerOptions: options.providerOptions
        }
      : rawInput;
    const startedAt = Date.now();
    this.logger.info('ai.act_started', {
      deterministic: false,
      action: input.action,
      instructionHash: hashSensitiveText(input.instruction),
      instructionLength: input.instruction.length
    });
    const config = await this.config();
    const timeoutMs = input.timeoutMs ?? config.runtimeAi.timeoutMs;
    const deadline = createActDeadline(timeoutMs);
    deadline.ensure();
    const firstSnapshot = await this.snapshot();
    deadline.ensure();
    const cache = this.getCache(config);
    const cacheInstruction = redactVariableValues(input.instruction, input.variables);
    const useCache = input.cache ?? options.cache ?? true;
    const key = cache.createKey({
      instruction: input.instruction,
      url: firstSnapshot.url,
      pageFingerprint: firstSnapshot.fingerprint,
      model: input.model ?? config.runtimeAi.model ?? config.ai.model,
      variables: input.variables
    });
    const cached = useCache ? await cache.get(key) : undefined;

    if (cached && (!input.action || cached.action === input.action)) {
      const cachedActions = transformActionVariables(
        cached.actions ?? [{
          selector: this.getExecutor().selector(cached.locator),
          description: input.instruction,
          method: cached.action,
          arguments: []
        }],
        input.variables,
        'hydrate'
      );
      const replayResults: AiActResult[] = [];
      for (const cachedAction of cachedActions) {
        deadline.ensure();
        const replayed = await this.takeDeterministicAction(
          cachedAction,
          {
            ...options,
            variables: input.variables,
            model: input.model,
            timeoutMs: deadline.remaining(),
            abortSignal: input.abortSignal,
            providerOptions: input.providerOptions
          },
          deadline,
          input.filePath
        );
        replayResults.push(replayed);
        if (!replayed.success) {
          break;
        }
      }
      if (replayResults.length > 0 && replayResults.every((result) => result.success)) {
        const replayedActions = replayResults.flatMap((result) => result.actions);
        const result: AiActResult = {
          success: true,
          message: replayResults.map((item) => item.message).join(' → '),
          actionDescription: cached.actions?.[0]?.description ?? input.instruction,
          actions: replayedActions,
          action: replayResults.at(-1)?.action ?? cached.action,
          locator: replayResults.at(-1)?.locator ?? cached.locator,
          fromCache: true,
          selfHealed: replayResults.some((item) => item.selfHealed),
          cacheStatus: 'HIT'
        };
        if (actionsChanged(cachedActions, replayedActions)) {
          await cache.set({
            key,
            instruction: cacheInstruction,
            url: firstSnapshot.url,
            pageFingerprint: firstSnapshot.fingerprint,
            model: input.model ?? config.runtimeAi.model ?? config.ai.model,
            variableNames: Object.keys(input.variables ?? {}).sort(),
            action: result.action ?? cached.action,
            locator: result.locator ?? cached.locator,
            actions: transformActionVariables(replayedActions, input.variables, 'template')
          }).catch(() => undefined);
        }
        await this.tryArtifact('act', { input, result });
        this.logger.info('ai.act_completed', {
          success: true,
          cacheStatus: 'HIT',
          selfHealed: result.selfHealed,
          actionCount: result.actions.length,
          durationMs: Date.now() - startedAt
        });
        return result;
      }
    }

    const result = await this.planAndExecute(input, firstSnapshot, deadline);
    if (useCache && result.success && result.action && result.locator) {
      await cache.set({
        key,
        instruction: cacheInstruction,
        url: firstSnapshot.url,
        pageFingerprint: firstSnapshot.fingerprint,
        model: input.model ?? config.runtimeAi.model ?? config.ai.model,
        variableNames: Object.keys(input.variables ?? {}).sort(),
        action: result.action,
        locator: result.locator,
        actions: transformActionVariables(result.actions, input.variables, 'template')
      }).catch(() => undefined);
    }
    await this.tryArtifact('act', { input, result });
    this.logger.info('ai.act_completed', {
      success: result.success,
      cacheStatus: result.cacheStatus,
      selfHealed: result.selfHealed,
      actionCount: result.actions.length,
      durationMs: Date.now() - startedAt
    });
    return result;
  }

  async assert(input: AiAssertInput): Promise<AiAssertResult> {
    const startedAt = Date.now();
    this.logger.info('ai.assert_started', {
      kind: input.kind,
      instructionHash: hashSensitiveText(input.instruction),
      instructionLength: input.instruction.length
    });
    const candidates = await this.observe(input.instruction, {
      timeoutMs: input.timeoutMs,
      variables: input.variables,
      model: input.model,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions
    });
    const candidate = candidates[0];
    const extracted = await this.extract(input.instruction, assertExtractSchema, {
      timeoutMs: input.timeoutMs,
      model: input.model,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions,
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
        const judgement = await this.completeObject<z.infer<typeof semanticJudgeSchema>>(config, {
          purpose: 'assert',
          system: 'Judge whether the browser facts satisfy the assertion. Do not infer missing evidence.',
          user: { assertion: input.instruction, expected: input.expected, facts },
          schema: semanticJudgeSchema,
          timeoutMs: input.timeoutMs,
          abortSignal: input.abortSignal,
          providerOptions: input.providerOptions,
          model: input.model
        });
        passed = judgement.value.passed;
        reason = judgement.value.reason;
        evidence = [...evidence, ...(judgement.value.evidence ?? [])];
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
      this.logger.error('ai.assert_failed', {
        message: 'AI assertion failed',
        kind: input.kind,
        reasonHash: hashSensitiveText(reason),
        artifactPath,
        durationMs: Date.now() - startedAt
      });
      throw runtimeError('AI_ASSERT_FAILED', `${reason}; artifact=${artifactPath}`, details);
    }

    const result: AiAssertResult = {
      passed: true,
      actual: facts,
      evidence,
      reason
    };
    await this.tryArtifact('assert', { input, result });
    this.logger.info('ai.assert_completed', {
      kind: input.kind,
      passed: true,
      durationMs: Date.now() - startedAt
    });
    return result;
  }

  agent(input: AiAgentInput): Promise<AiAgentResult>;
  agent(config: AiAgentConfig & { stream: true }): AiStreamingAgentInstance;
  agent(config?: AiAgentConfig & { stream?: false }): AiAgentInstance;
  agent(input?: AiAgentInput | AiAgentConfig):
    Promise<AiAgentResult> | AiAgentInstance | AiStreamingAgentInstance {
    if (isAgentInput(input)) {
      return this.runAgent(input, {});
    }
    const agentConfig = input ?? {};
    if (agentConfig.stream) {
      return {
        execute: async (execution) => this.streamAgent(
          normalizeAgentInput(execution),
          agentConfig
        )
      };
    }
    return {
      execute: async (execution) => this.runAgent(
        normalizeAgentInput(execution),
        agentConfig
      )
    };
  }

  private async runAgent(input: AiAgentInput, agentConfig: AiAgentConfig): Promise<AiAgentResult> {
    const config = await this.config();
    const model = this.getModel(config);
    if (!model.getLanguageModel) {
      throw runtimeError(
        'AI_MODEL_CAPABILITY_UNSUPPORTED',
        'DOM Agent requires an AI SDK v7 language model with tool calling'
      );
    }
    return this.runSdkAgent(input, agentConfig, config, model as RuntimeModelClient);
  }

  private buildAgentLoop(
    input: AiAgentInput,
    config: VoleConfig,
    history: AiAgentHistoryItem[],
    modelName: string,
    agentConfig: AiAgentConfig,
    maxSteps: number,
    model: RuntimeModelClient
  ) {
    const tools = this.createSdkAgentTools(
      input,
      config,
      history,
      agentConfig.tools,
      agentConfig.executionModel,
      agentConfig.excludeTools,
      agentConfig.toolMeta
    );
    const probe: { observation?: unknown } = {};
    return new ToolLoopAgent({
      model: model.getLanguageModel(modelName),
      instructions: agentConfig.systemPrompt ?? agentSystemPrompt(),
      tools,
      stopWhen: [hasToolCall('done'), stepCountIs(maxSteps)],
      prepareStep: input.callbacks?.prepareStep,
      onStepFinish: (event) => this.handleAgentStep(input, event, probe),
      providerOptions: input.providerOptions
    });
  }

  private async finalizeAgentDone(
    input: AiAgentInput,
    config: VoleConfig,
    history: AiAgentHistoryItem[],
    modelName: string,
    agentConfig: AiAgentConfig,
    model: RuntimeModelClient,
    instructions: string,
    timeoutMs: number
  ): Promise<ReturnType<typeof lastDone>> {
    const existing = lastDone(history);
    if (existing) {
      return existing;
    }
    const forcedTools = this.createSdkAgentTools(
      input,
      config,
      history,
      undefined,
      agentConfig.executionModel,
      agentConfig.excludeTools,
      agentConfig.toolMeta
    );
    const finalizer = new ToolLoopAgent({
      model: model.getLanguageModel(modelName),
      instructions,
      tools: { done: forcedTools.done },
      toolChoice: 'auto',
      stopWhen: hasToolCall('done'),
      providerOptions: input.providerOptions
    });
    await finalizer.generate({
      prompt: JSON.stringify({ goal: input.instruction, history: safeValue(history) }),
      abortSignal: input.abortSignal,
      timeout: timeoutMs
    });
    return lastDone(history);
  }

  private buildAgentResult(
    input: AiAgentInput,
    done: NonNullable<ReturnType<typeof lastDone>>,
    history: AiAgentHistoryItem[],
    responseMessages: readonly ModelMessage[],
    usage: Parameters<typeof toRuntimeUsage>[0],
    startedAt: number
  ): AiAgentResult {
    return {
      success: true,
      message: done.message,
      steps: history.length,
      history,
      actions: history,
      completed: true,
      usage: {
        ...toRuntimeUsage(usage),
        inferenceTimeMs: Date.now() - startedAt
      },
      messages: [
        ...(input.messages ?? []),
        ...(input.messages?.length
          ? [{ role: 'user' as const, content: input.instruction }]
          : []),
        ...responseMessages
      ],
      output: done.output,
      cacheStatus: 'MISS',
      selfHealed: false
    };
  }

  private async handleAgentTerminalError(
    input: AiAgentInput,
    error: unknown,
    history: AiAgentHistoryItem[]
  ): Promise<Error> {
    const mapped = error instanceof Error ? error : new Error(String(error));
    const terminalError = normalizeAgentError(mapped, history);
    if (input.abortSignal?.aborted) {
      await input.callbacks?.onAbort?.();
    } else {
      await input.callbacks?.onError?.(terminalError);
    }
    return terminalError;
  }

  private async runSdkAgent(
    input: AiAgentInput,
    agentConfig: AiAgentConfig,
    config: VoleConfig,
    model: RuntimeModelClient
  ): Promise<AiAgentResult> {
    const history: AiAgentHistoryItem[] = [];
    const maxSteps = input.maxSteps ?? config.runtimeAi.agent.maxSteps;
    const startedAt = Date.now();
    this.logger.info('ai.agent_started', {
      instructionHash: hashSensitiveText(input.instruction),
      instructionLength: input.instruction.length,
      maxSteps
    });
    const cache = this.getCache(config);
    const initialSnapshot = await this.snapshot();
    const modelName = agentConfig.model ?? config.runtimeAi.model ?? config.ai.model;
    const configSignature = createHash('sha256')
      .update(JSON.stringify({
        mode: 'dom',
        model: modelName,
        executionModel: agentConfig.executionModel,
        maxSteps,
        customTools: Object.keys(agentConfig.tools ?? {}).sort(),
        excludeTools: [...(agentConfig.excludeTools ?? [])].sort(),
        toolMeta: agentConfig.toolMeta,
        systemPrompt: agentConfig.systemPrompt,
        providerOptions: input.providerOptions,
        variableDescriptions: variablePromptEntries(input.variables),
        sameOriginOnly: config.runtimeAi.agent.sameOriginOnly
      }))
      .digest('hex');
    const cacheEligible = !agentConfig.tools &&
      !input.messages?.length &&
      input.output === undefined;
    const cacheKey = cache.createAgentKey({
      instruction: input.instruction,
      url: initialSnapshot.url,
      model: modelName,
      configSignature,
      variables: input.variables
    });
    if (cacheEligible) {
      const cached = await cache.getAgentTrajectory(cacheKey);
      if (cached) {
        try {
          const replayed = await this.replayTrajectory(
            cached.history,
            input,
            config,
            agentConfig.executionModel,
            agentConfig.toolMeta
          );
          const result: AiAgentResult = {
            success: true,
            message: cached.resultMessage,
            steps: replayed.length,
            history: replayed,
            actions: replayed,
            completed: true,
            cacheStatus: 'HIT',
            selfHealed: replayed.some((item) =>
              item.output &&
              typeof item.output === 'object' &&
              (item.output as Record<string, unknown>).selfHealed === true
            )
          };
          await cache.setAgentTrajectory({
            key: cacheKey,
            instruction: redactVariableValues(input.instruction, input.variables),
            url: initialSnapshot.url,
            model: modelName,
            configSignature,
            variableNames: Object.keys(input.variables ?? {}).sort(),
            history: transformHistoryVariables(replayed, input.variables, 'template'),
            resultMessage: cached.resultMessage
          }).catch(() => undefined);
          await input.callbacks?.onEvidence?.({ type: 'final', data: result });
          await input.callbacks?.onFinish?.(result);
          this.logger.info('ai.agent_completed', {
            success: true,
            cacheStatus: 'HIT',
            steps: result.steps,
            selfHealed: result.selfHealed,
            durationMs: Date.now() - startedAt
          });
          return result;
        } catch {
          await cache.deleteAgentTrajectory(cacheKey);
        }
      }
    }

    const loop = this.buildAgentLoop(input, config, history, modelName, agentConfig, maxSteps, model);

    try {
      const generated = await loop.generate({
        ...agentCallPrompt(input, this.page.url()),
        abortSignal: input.abortSignal,
        timeout: input.timeoutMs ?? config.runtimeAi.agent.timeoutMs
      });
      const done = await this.finalizeAgentDone(
        input,
        config,
        history,
        modelName,
        agentConfig,
        model,
        'Call done once. Report success only when the supplied history proves the goal.',
        Math.min(
          input.timeoutMs ?? config.runtimeAi.agent.timeoutMs,
          config.runtimeAi.agent.toolTimeoutMs
        )
      );
      if (!done?.success) {
        throw runtimeError(
          'AI_AGENT_FAILED',
          done?.message ?? 'agent stopped without a successful done result',
          { history }
        );
      }

      const result = this.buildAgentResult(
        input,
        done,
        history,
        generated.responseMessages,
        generated.usage,
        startedAt
      );
      if (cacheEligible) {
        await cache.setAgentTrajectory({
          key: cacheKey,
          instruction: redactVariableValues(input.instruction, input.variables),
          url: initialSnapshot.url,
          model: modelName,
          configSignature,
          variableNames: Object.keys(input.variables ?? {}).sort(),
          history: transformHistoryVariables(history, input.variables, 'template'),
          resultMessage: redactVariableValues(done.message, input.variables)
        }).catch(() => undefined);
      }
      await input.callbacks?.onEvidence?.({ type: 'final', data: result });
      await input.callbacks?.onFinish?.(result);
      await this.tryArtifact('agent', { input, result });
      this.logger.info('ai.agent_completed', {
        success: true,
        cacheStatus: result.cacheStatus,
        steps: result.steps,
        selfHealed: result.selfHealed,
        durationMs: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      const terminalError = await this.handleAgentTerminalError(input, error, history);
      const artifactPath = await this.tryArtifact('agent-failed', {
        input,
        history,
        error: terminalError.message
      });
      this.logger.error('ai.agent_failed', {
        message: 'AI agent failed',
        steps: history.length,
        errorName: terminalError.name,
        errorCode: terminalError instanceof AiRuntimeError ? terminalError.code : undefined,
        errorMessageHash: hashSensitiveText(terminalError.message),
        artifactPath,
        durationMs: Date.now() - startedAt
      });
      if (terminalError instanceof AiRuntimeError && terminalError.code !== 'AI_AGENT_FAILED') {
        throw terminalError;
      }
      throw runtimeError(
        'AI_AGENT_FAILED',
        `${terminalError.message}; artifact=${artifactPath}`,
        { history }
      );
    }
  }

  private async streamAgent(
    input: AiAgentInput,
    agentConfig: AiAgentConfig
  ): Promise<
    Awaited<ReturnType<ToolLoopAgent<never, ToolSet>['stream']>> & {
      result: Promise<AiAgentResult>;
    }
  > {
    const config = await this.config();
    const model = this.getModel(config);
    if (!model.getLanguageModel) {
      throw runtimeError(
        'AI_MODEL_CAPABILITY_UNSUPPORTED',
        'streaming DOM Agent requires an AI SDK v7 language model with tool calling'
      );
    }
    const runtimeModel = model as RuntimeModelClient;
    const history: AiAgentHistoryItem[] = [];
    const modelName = agentConfig.model ?? config.runtimeAi.model ?? config.ai.model;
    const maxSteps = input.maxSteps ?? config.runtimeAi.agent.maxSteps;
    const startedAt = Date.now();
    const loop = this.buildAgentLoop(input, config, history, modelName, agentConfig, maxSteps, runtimeModel);
    let streamed: Awaited<ReturnType<typeof loop.stream>>;
    try {
      streamed = await loop.stream({
        ...agentCallPrompt(input, this.page.url()),
        abortSignal: input.abortSignal,
        timeout: input.timeoutMs ?? config.runtimeAi.agent.timeoutMs
      });
    } catch (error) {
      const terminalError = await this.handleAgentTerminalError(input, error, history);
      throw terminalError;
    }
    const result = (async (): Promise<AiAgentResult> => {
      try {
        const [usage, responseMessages] = await Promise.all([
          streamed.usage,
          streamed.responseMessages
        ]);
        const done = await this.finalizeAgentDone(
          input,
          config,
          history,
          modelName,
          agentConfig,
          runtimeModel,
          'Call done once based only on the verified streaming agent history.',
          config.runtimeAi.agent.toolTimeoutMs
        );
        if (!done?.success) {
          throw runtimeError(
            'AI_AGENT_FAILED',
            done?.message ?? 'streaming agent did not complete',
            { history }
          );
        }
        const value = this.buildAgentResult(input, done, history, responseMessages, usage, startedAt);
        await input.callbacks?.onEvidence?.({ type: 'final', data: value });
        await input.callbacks?.onFinish?.(value);
        return value;
      } catch (error) {
        const terminalError = await this.handleAgentTerminalError(input, error, history);
        throw terminalError;
      }
    })();
    const textStream = this.withChunkCallback(
      streamed.textStream,
      input
    ) as typeof streamed.textStream;
    return new Proxy(streamed, {
      get(target, property) {
        if (property === 'textStream') {
          return textStream;
        }
        if (property === 'result') {
          return result;
        }
        return Reflect.get(target, property, target);
      }
    }) as typeof streamed & { result: Promise<AiAgentResult> };
  }

  private createSdkAgentTools(
    agentInput: AiAgentInput,
    config: VoleConfig,
    history: AiAgentHistoryItem[],
    customTools?: ToolSet,
    executionModel?: string,
    excludeTools: string[] = [],
    toolMeta?: Record<string, ToolKind>
  ): ToolSet {
    const recordResult = async (
      name: string,
      toolInput: unknown,
      output: unknown
    ): Promise<unknown> => {
      const item: AiAgentHistoryItem = {
        step: history.length + 1,
        tool: name,
        input: safeValue(toolInput),
        output: safeValue(output)
      };
      history.push(item);
      await agentInput.callbacks?.onToolFinish?.(item);
      await agentInput.callbacks?.onEvidence?.({
        type: name === 'screenshot'
          ? 'screenshot'
          : verificationTool(name, toolMeta)
            ? 'observation'
            : 'action',
        step: item.step,
        data: item
      });
      return output;
    };
    const execute = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      const startedAt = Date.now();
      let output: unknown;
      try {
        output = name === 'done' &&
          Boolean(input.success ?? input.taskComplete) &&
          !hasVerificationAfterLastMutation(history, toolMeta)
          ? { success: false, message: verificationGateMessage() }
          : await withTimeout(
              this.executeAgentTool(name, input, agentInput, config, executionModel),
              config.runtimeAi.agent.toolTimeoutMs,
              name
            );
      } catch (error) {
        if (shouldTerminateAgentTool(error)) {
          throw error;
        }
        output = {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
      const result = await recordResult(name, input, output);
      this.logger.info('ai.agent_tool_completed', {
        tool: name,
        step: history.length,
        success: !(
          output && typeof output === 'object' &&
          ('error' in output || (output as { success?: unknown }).success === false)
        ),
        durationMs: Date.now() - startedAt
      });
      return result;
    };
    const wrappedCustomTools = Object.fromEntries(
      Object.entries(customTools ?? {}).map(([name, customTool]) => {
        const candidate = customTool as {
          execute?: (input: unknown, options: unknown) => unknown | PromiseLike<unknown>;
        };
        if (typeof candidate.execute !== 'function') {
          return [name, customTool];
        }
        const originalExecute = candidate.execute.bind(customTool);
        return [name, {
          ...customTool,
          execute: async (toolInput: unknown, toolOptions: unknown) => {
            let output: unknown;
            try {
              output = await withTimeout(
                Promise.resolve(originalExecute(toolInput, toolOptions)),
                config.runtimeAi.agent.toolTimeoutMs,
                name
              );
            } catch (error) {
              if (shouldTerminateAgentTool(error)) {
                throw error;
              }
              output = {
                success: false,
                error: error instanceof Error ? error.message : String(error)
              };
            }
            return recordResult(name, toolInput, output);
          }
        }];
      })
    ) as ToolSet;
    const doneOutputSchema = agentInput.output ?? z.record(z.unknown());
    const tools: ToolSet = {
      ariaTree: aiTool({
        description: 'Read the current page DOM/accessibility tree',
        inputSchema: z.object({}),
        execute: (input) => execute('ariaTree', input),
        toModelOutput: ({ output }) => {
          const result = output as {
            success?: boolean;
            content?: string;
            error?: string;
            pageUrl?: string;
          };
          return {
            type: 'content' as const,
            value: [{
              type: 'text' as const,
              text: result.success && result.content
                ? `${result.content}\npageUrl=${result.pageUrl ?? ''}`
                : JSON.stringify(result)
            }]
          };
        }
      }),
      act: aiTool({
        description: 'Perform a semantic browser action such as clicking or typing',
        inputSchema: z.object({
          action: z.string().min(1).describe(
            'A short action such as "click Login" or "type %email% into the email input"'
          )
        }),
        execute: (input) => execute('act', input)
      }),
      extract: aiTool({
        description: 'Extract structured facts from the page using an optional JSON Schema',
        inputSchema: z.object({
          instruction: z.string().min(1),
          schema: z.record(z.unknown()).optional()
        }),
        execute: (input) => execute('extract', input)
      }),
      fillForm: aiTool({
        description: 'Fill several form fields',
        inputSchema: z.object({
          fields: z.array(z.object({
            action: z.string().min(1).describe(
              'For example: "type %email% into the email input"'
            )
          })).min(1)
        }),
        execute: (input) => execute('fillForm', input)
      }),
      goto: aiTool({
        description: 'Navigate to a same-origin URL',
        inputSchema: z.object({ url: z.string().min(1) }),
        execute: (input) => execute('goto', input)
      }),
      keys: aiTool({
        description: 'Type text or press keys in the currently focused element',
        inputSchema: z.object({
          method: z.enum(['press', 'type']),
          value: z.string().min(1),
          repeat: z.number().int().positive().optional()
        }),
        execute: (input) => execute('keys', input)
      }),
      navback: aiTool({
        description: 'Navigate back one page',
        inputSchema: z.object({ reasoningText: z.string().optional() }),
        execute: (input) => execute('navback', input)
      }),
      screenshot: aiTool({
        description: 'Capture viewport evidence',
        inputSchema: z.object({}),
        execute: (input) => execute('screenshot', input),
        toModelOutput: ({ output }) => {
          const result = output as {
            success?: boolean;
            error?: string;
            base64?: string;
          };
          if (!result.success || result.error || !result.base64) {
            return {
              type: 'content' as const,
              value: [{ type: 'text' as const, text: JSON.stringify(result) }]
            };
          }
          return {
            type: 'content' as const,
            value: [{
              type: 'media' as const,
              mediaType: 'image/png',
              data: result.base64
            }]
          };
        }
      } as Parameters<typeof aiTool<{}, unknown, Record<string, unknown>>>[0]),
      scroll: aiTool({
        description: 'Scroll up or down by a percentage of the viewport',
        inputSchema: z.object({
          direction: z.enum(['up', 'down']),
          percentage: z.number().min(1).max(200).optional()
        }),
        execute: (input) => execute('scroll', input)
      }),
      think: aiTool({
        description: 'Record a concise plan without changing the page',
        inputSchema: z.object({ reasoning: z.string().min(1) }),
        execute: (input) => execute('think', input)
      }),
      wait: aiTool({
        description: 'Wait briefly for asynchronous UI updates',
        inputSchema: z.object({ timeMs: z.number().int().min(0).max(10000) }),
        execute: (input) => execute('wait', input)
      }),
      done: aiTool({
        description: 'Finish only after the final state was verified',
        inputSchema: z.object({
          success: z.boolean().optional(),
          taskComplete: z.boolean().optional(),
          message: z.string().optional(),
          reasoning: z.string().optional(),
          output: doneOutputSchema.optional()
        }),
        execute: (input) => execute('done', input)
      }),
      ...wrappedCustomTools
    };
    return Object.fromEntries(
      Object.entries(tools).filter(([name]) =>
        customTools?.[name] !== undefined || !excludeTools.includes(name)
      )
    );
  }

  private async replayTrajectory(
    cachedHistory: AiAgentHistoryItem[],
    input: AiAgentInput,
    config: VoleConfig,
    executionModel?: string,
    toolMeta?: Record<string, ToolKind>
  ): Promise<AiAgentHistoryItem[]> {
    const history: AiAgentHistoryItem[] = [];
    for (const item of transformHistoryVariables(cachedHistory, input.variables, 'hydrate')) {
      if (['done', 'think', 'screenshot'].includes(item.tool)) {
        continue;
      }
      const toolInput = z.record(z.unknown()).parse(item.input);
      let output: unknown;
      if (item.tool === 'act') {
        output = await this.replayCachedAgentAction(item, toolInput, input, config, executionModel);
      } else {
        output = await this.executeAgentTool(item.tool, toolInput, input, config, executionModel);
      }
      const replayedItem: AiAgentHistoryItem = {
        step: history.length + 1,
        tool: item.tool,
        input: safeValue(toolInput),
        output: safeValue(output)
      };
      history.push(replayedItem);
      await input.callbacks?.onToolFinish?.(replayedItem);
    }
    if (!hasVerificationAfterLastMutation(history, toolMeta)) {
      throw runtimeError('AI_AGENT_FAILED', 'cached trajectory did not verify the final state');
    }
    return history;
  }

  private async replayCachedAgentAction(
    cached: AiAgentHistoryItem,
    toolInput: Record<string, unknown>,
    input: AiAgentInput,
    config: VoleConfig,
    executionModel?: string
  ): Promise<unknown> {
    const cachedOutput = cached.output && typeof cached.output === 'object'
      ? cached.output as Record<string, unknown>
      : undefined;
    const actions = Array.isArray(cachedOutput?.actions)
      ? cachedOutput.actions.filter(isReplayableAction)
      : [];
    if (actions.length > 0) {
      try {
        const results: AiActResult[] = [];
        for (const action of actions) {
          const deadline = createActDeadline(config.runtimeAi.timeoutMs);
          const result = await this.takeDeterministicAction(action, {
            variables: input.variables,
            model: executionModel,
            timeoutMs: config.runtimeAi.timeoutMs,
            abortSignal: input.abortSignal,
            providerOptions: input.providerOptions
          }, deadline);
          results.push(result);
          if (!result.success) {
            throw runtimeError('AI_ACT_FAILED', result.message);
          }
        }
        return {
          success: results.every((result) => result.success),
          actions: results.flatMap((result) => result.actions),
          fromCache: true,
          selfHealed: results.some((result) => result.selfHealed)
        };
      } catch (error) {
        // Only a DOM/stale-locator failure should fall through to semantic act.
        // Abort, timeout, and unrelated runtime errors must propagate.
        if (isCancellation(error)) {
          throw error;
        }
        if (error instanceof AiRuntimeError && error.code !== 'AI_ACT_FAILED') {
          throw error;
        }
      }
    }
    const healed = await this.executeAgentTool('act', toolInput, input, config, executionModel);
    return healed && typeof healed === 'object'
      ? { ...(healed as Record<string, unknown>), fromCache: true, selfHealed: true }
      : healed;
  }

  private async handleAgentStep(
    input: AiAgentInput,
    event: StepResult<ToolSet, Record<string, unknown>>,
    probe: { observation?: unknown } = {}
  ): Promise<void> {
    await input.callbacks?.onStepFinish?.(event);
    if (!input.callbacks?.onEvidence) {
      return;
    }
    const stepMutated = event.toolCalls.some((call) => !NON_MUTATING_STEP_TOOLS.has(call.toolName));
    let observation: unknown;
    if (!stepMutated && probe.observation !== undefined) {
      observation = probe.observation;
    } else {
      try {
        const snapshot = await this.snapshot();
        const screenshot = await this.page.screenshot({ fullPage: false });
        observation = {
          url: snapshot.url,
          tree: snapshot.text,
          screenshotBase64: screenshot.toString('base64')
        };
        probe.observation = observation;
      } catch (error) {
        observation = {
          url: this.page.url(),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }
    await input.callbacks.onEvidence({
      type: 'step_finished',
      step: event.stepNumber,
      data: {
        finishReason: event.finishReason,
        text: event.text,
        toolCalls: event.toolCalls.map((call) => ({
          toolName: call.toolName,
          input: safeValue(call.input)
        })),
        observation
      }
    });
  }

  private async *withChunkCallback(
    stream: AsyncIterable<string>,
    input: AiAgentInput
  ): AsyncIterable<string> {
    try {
      for await (const chunk of stream) {
        await input.callbacks?.onChunk?.(chunk);
        yield chunk;
      }
    } catch (error) {
      const mapped = error instanceof Error ? error : new Error(String(error));
      await input.callbacks?.onError?.(mapped);
      throw mapped;
    }
  }

  async close(): Promise<void> {
    await this.snapshotter?.close();
    await this.executor?.close();
    await this.logger.flush();
  }

  private async planAndExecute(
    input: AiActInput,
    snapshot: PageSnapshot,
    deadline: ActDeadline
  ): Promise<AiActResult> {
    const config = await this.config();
    deadline.ensure();
    const response = await this.completeObject<z.infer<typeof actionPlanSchema>>(config, {
      purpose: 'act',
      system: buildActSystemPrompt(),
      user: buildActUserPrompt(
        buildActPrompt(input, input.variables),
        snapshot.text
      ),
      schema: actionPlanSchema,
      timeoutMs: deadline.remaining(),
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions,
      model: input.model
    });
    const plan = normalizeActionPlan(response.value);
    if (!plan?.elementId) {
      return {
        success: false,
        message: 'Failed to perform act: No action found',
        actionDescription: input.instruction,
        actions: [],
        fromCache: false,
        selfHealed: false,
        cacheStatus: 'MISS',
        usage: response.usage
      };
    }
    const node = actionableSnapshotNode(snapshot, plan.elementId);
    const locator = node?.locators[0];
    if (!node || !locator) {
      throw runtimeError('AI_ACT_FAILED', `model selected unknown or unlocatable element ${plan.elementId}`);
    }
    const method = input.action ?? plan.method;
    if (input.action && plan.method !== input.action) {
      throw runtimeError(
        'AI_ACT_FAILED',
        `model returned method ${plan.method}, expected ${input.action}`
      );
    }
    const dragTargetNode = method === 'dragAndDrop'
      ? actionableSnapshotNode(snapshot, plan.arguments?.[0])
      : undefined;
    const dragTargetLocator = dragTargetNode?.locators[0];
    const description = plan.description || input.instruction;
    const firstAction: AiAction = {
      selector: node.xpath
        ? `xpath=${node.xpath}`
        : this.getExecutor().selector(locator),
      description,
      method,
      locator,
      arguments: method === 'dragAndDrop' && dragTargetNode && dragTargetLocator
        ? [
            dragTargetNode.xpath
              ? `xpath=${dragTargetNode.xpath}`
              : this.getExecutor().selector(dragTargetLocator)
          ]
        : input.value !== undefined
          ? [input.value, ...plan.arguments.slice(1)]
          : plan.arguments
    };
    const firstResult = await this.takeDeterministicAction(
      firstAction,
      {
        variables: input.variables,
        timeoutMs: deadline.remaining(),
        model: input.model,
        cache: input.cache,
        abortSignal: input.abortSignal,
        providerOptions: input.providerOptions
      },
      deadline,
      input.filePath
    );
    const firstWithUsage = { ...firstResult, usage: response.usage };
    if (response.value.twoStep !== true) {
      return firstWithUsage;
    }

    let usage = response.usage;
    deadline.ensure();
    const secondSnapshot = await this.snapshot();
    let diff = snapshotDiff(snapshot, secondSnapshot);
    if (!diff.trim()) {
      diff = secondSnapshot.text;
    }
    deadline.ensure();
    const secondResponse = await this.completeObject<z.infer<typeof actionPlanSchema>>(config, {
      purpose: 'act-second-step',
      system: buildActSystemPrompt(),
      user: buildActUserPrompt(
        buildActStepTwoPrompt(
          input.instruction,
          firstAction,
          input.variables
        ),
        diff
      ),
      schema: actionPlanSchema,
      timeoutMs: deadline.remaining(),
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions,
      model: input.model
    });
    usage = mergeUsage(usage, secondResponse.usage);
    const secondPlan = normalizeActionPlan(secondResponse.value);
    if (!secondPlan?.elementId) {
      return { ...firstWithUsage, usage };
    }
    const secondNode = actionableSnapshotNode(secondSnapshot, secondPlan.elementId);
    const secondLocator = secondNode?.locators[0];
    if (!secondNode || !secondLocator) {
      throw runtimeError('AI_ACT_FAILED', `second step selected unknown element ${secondPlan.elementId}`);
    }
    const secondTarget = secondPlan.method === 'dragAndDrop'
      ? actionableSnapshotNode(secondSnapshot, secondPlan.arguments[0])
      : undefined;
    const secondAction: AiAction = {
      selector: secondNode.xpath
        ? `xpath=${secondNode.xpath}`
        : this.getExecutor().selector(secondLocator),
      description: secondPlan.description || `Complete ${input.instruction}`,
      method: secondPlan.method,
      locator: secondLocator,
      arguments: secondTarget
        ? [
            secondTarget.xpath
              ? `xpath=${secondTarget.xpath}`
              : this.getExecutor().selector(secondTarget.locators[0]!)
          ]
        : secondPlan.arguments
    };
    const secondResult = await this.takeDeterministicAction(
      secondAction,
      {
        variables: input.variables,
        timeoutMs: deadline.remaining(),
        model: input.model,
        cache: input.cache,
        abortSignal: input.abortSignal,
        providerOptions: input.providerOptions
      },
      deadline,
      input.filePath
    );
    return {
      success: firstResult.success && secondResult.success,
      message: `${firstResult.message} → ${secondResult.message}`,
      actionDescription: firstResult.actionDescription,
      actions: [...firstResult.actions, ...secondResult.actions],
      action: secondResult.action ?? firstResult.action,
      locator: secondResult.locator ?? firstResult.locator,
      fromCache: false,
      selfHealed: firstResult.selfHealed || secondResult.selfHealed,
      cacheStatus: 'MISS',
      usage
    };
  }

  private async takeDeterministicAction(
    action: AiAction,
    options: AiActOptions,
    deadline: ActDeadline,
    filePath?: string
  ): Promise<AiActResult> {
    const config = await this.config();
    const method = action.method?.trim();
    if (!method || method === 'not-supported') {
      return {
        success: false,
        message: `Unable to perform action: The method '${method ?? ''}' is not supported in Action. Please use a supported Playwright locator method.`,
        actionDescription: action.description || `Action (${method || 'unknown'})`,
        actions: [],
        fromCache: false,
        selfHealed: false,
        cacheStatus: 'MISS'
      };
    }
    const placeholderArguments = [...(action.arguments ?? [])];
    const resolvedArguments = placeholderArguments.map((argument) =>
      substituteVariables(argument, options.variables)
    );
    const execute = async (
      targetAction: AiAction
    ): Promise<{ locator: LocatorDescriptor; recorded: AiAction }> => {
      deadline.ensure();
      const locator = await this.resolveActionLocator(targetAction);
      deadline.ensure();
      await this.getExecutor().execute({
        method,
        locator,
        value: resolvedArguments[0] ?? '',
        arguments: resolvedArguments,
        filePath,
        targetLocator: method === 'dragAndDrop' && resolvedArguments[0]
          ? await this.resolveActionLocator({ selector: resolvedArguments[0] })
          : undefined,
        timeoutMs: deadline.remaining()
      });
      return {
        locator,
        recorded: {
          selector: targetAction.selector,
          description: action.description || `action (${method})`,
          method,
          arguments: placeholderArguments,
          locator
        }
      };
    };

    try {
      const performed = await execute(action);
      return successfulDeterministicResult(
        method as AiActionMethod,
        performed.locator,
        performed.recorded,
        false
      );
    } catch (error) {
      rethrowActTimeout(error);
      if (!config.runtimeAi.selfHeal) {
        return failedDeterministicResult(
          method,
          action.description,
          `Failed to perform act: ${errorMessage(error)}`
        );
      }

      const command = action.description
        ? action.description.toLowerCase().startsWith(method.toLowerCase())
          ? action.description
          : `${method} ${action.description}`
        : method;
      try {
        deadline.ensure();
        const snapshot = await this.snapshot();
        deadline.ensure();
        const response = await this.completeObject<z.infer<typeof actionPlanSchema>>(config, {
          purpose: 'act',
          system: buildActSystemPrompt(),
          user: buildActUserPrompt(
            buildActPrompt({ instruction: command }, undefined),
            snapshot.text
          ),
          schema: actionPlanSchema,
          timeoutMs: deadline.remaining(),
          abortSignal: options.abortSignal,
          providerOptions: options.providerOptions,
          model: options.model
        });
        const fallback = normalizeActionPlan(response.value);
        const node = fallback?.elementId
          ? actionableSnapshotNode(snapshot, fallback.elementId)
          : undefined;
        if (!node?.xpath || !node.locators[0]) {
          return failedDeterministicResult(
            method,
            command,
            'Failed to self-heal act: No observe results found for action',
            response.usage
          );
        }
        const performed = await execute({
          ...action,
          selector: `xpath=${node.xpath}`,
          locator: node.locators[0]
        });
        return {
          ...successfulDeterministicResult(
            method as AiActionMethod,
            performed.locator,
            performed.recorded,
            true
          ),
          usage: response.usage
        };
      } catch (retryError) {
        rethrowActTimeout(retryError);
        return failedDeterministicResult(
          method,
          action.description,
          `Failed to perform act after self-heal: ${errorMessage(retryError)}`
        );
      }
    }
  }

  private async resolveActionLocator(action: Pick<AiAction, 'selector' | 'locator'>): Promise<LocatorDescriptor> {
    const supplied = action.locator;
    if (supplied?.backendNodeId !== undefined) {
      return supplied;
    }

    const normalizedSelector = action.selector.replace(/^xpath=/iu, '').trim();
    if (normalizedSelector.startsWith('/')) {
      const snapshot = this.latestSnapshot?.url === this.page.url()
        ? this.latestSnapshot
        : await this.captureSnapshot();
      const selected = snapshot.nodes.find((candidate) => candidate.xpath === normalizedSelector);
      const node = actionableSnapshotNode(snapshot, selected?.elementId);
      const locator = node?.locators[0];
      if (locator) {
        return locator;
      }
    }
    return supplied ?? this.getExecutor().descriptorFromSelector(action.selector);
  }

  private async executeAgentTool(
    name: string,
    input: Record<string, unknown>,
    agentInput: AiAgentInput,
    config: VoleConfig,
    executionModel?: string
  ): Promise<unknown> {
    switch (name) {
      case 'observe':
        return this.observe(requiredString(input, 'instruction'), {
          variables: agentInput.variables,
          abortSignal: agentInput.abortSignal,
          providerOptions: agentInput.providerOptions,
          model: executionModel
        });
      case 'ariaTree':
      {
        const result = await this.extract({
          abortSignal: agentInput.abortSignal,
          providerOptions: agentInput.providerOptions,
          model: executionModel
        });
        return {
          success: true,
          content: result.pageText,
          pageUrl: this.page.url()
        };
      }
      case 'act':
      {
        const legacyInstruction = optionalString(input.instruction);
        const value = optionalString(input.value);
        return this.act({
          instruction: legacyInstruction ?? requiredString(input, 'action'),
          action: legacyInstruction ? optionalAction(input.action) : undefined,
          target: optionalString(input.target),
          value: value ? substituteVariables(value, agentInput.variables) : undefined,
          variables: agentInput.variables,
          abortSignal: agentInput.abortSignal,
          providerOptions: agentInput.providerOptions,
          model: executionModel
        });
      }
      case 'assert':
        return this.assert({
          instruction: requiredString(input, 'instruction'),
          kind: z.enum(['visible', 'hidden', 'text', 'containsText', 'enabled', 'disabled', 'semantic'])
            .parse(input.kind),
          target: optionalString(input.target),
          expected: optionalString(input.expected),
          variables: agentInput.variables,
          abortSignal: agentInput.abortSignal,
          providerOptions: agentInput.providerOptions
        });
      case 'extract':
      {
        const schema = input.schema && typeof input.schema === 'object'
          ? jsonSchemaToZod(input.schema as JsonSchema)
          : z.object({ extraction: z.string() });
        return this.extract(requiredString(input, 'instruction'), schema, {
          model: executionModel,
          abortSignal: agentInput.abortSignal,
          providerOptions: agentInput.providerOptions
        });
      }
      case 'fillForm': {
        const fields = z.array(z.union([
          z.object({ action: z.string().min(1) }),
          z.object({ target: z.string().min(1), value: z.string() })
        ])).parse(input.fields).map((field) => (
          'action' in field
            ? field
            : { action: `type ${field.value} into the ${field.target} input` }
        ));
        const instruction = `Return observation results for these form actions: ${
          fields.map((field) => field.action).join(', ')
        }`;
        const observed = await this.observe(instruction, {
          variables: agentInput.variables,
          abortSignal: agentInput.abortSignal,
          providerOptions: agentInput.providerOptions,
          model: executionModel
        });
        const results: AiActResult[] = [];
        for (const action of observed) {
          results.push(await this.act(action, {
            variables: agentInput.variables,
            abortSignal: agentInput.abortSignal,
            providerOptions: agentInput.providerOptions,
            model: executionModel
          }));
        }
        return { success: results.every((result) => result.success), actions: results };
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
        const percentage = typeof input.percentage === 'number' ? input.percentage : 80;
        const viewportHeight = await this.page.evaluate(() => window.innerHeight);
        const amount = Math.round(viewportHeight * percentage / 100);
        await this.page.mouse.wheel(0, direction === 'down' ? amount : -amount);
        return { success: true, direction, percentage, scrolledPixels: amount };
      }
      case 'keys': {
        const method = input.method === undefined
          ? 'press'
          : z.enum(['press', 'type']).parse(input.method);
        const originalValue = optionalString(input.value) ?? requiredString(input, 'key');
        const value = substituteVariables(originalValue, agentInput.variables);
        const repeat = Math.max(1, typeof input.repeat === 'number' ? input.repeat : 1);
        for (let index = 0; index < repeat; index += 1) {
          if (method === 'type') {
            await this.page.keyboard.type(value, { delay: 100 });
          } else {
            await this.page.keyboard.press(value);
          }
        }
        return { success: true, method, value: originalValue, repeat };
      }
      case 'pressKey': {
        const key = requiredString(input, 'key');
        await this.page.keyboard.press(key);
        return { key };
      }
      case 'navback':
      case 'navBack':
      case 'goBack':
        await this.page.goBack({ waitUntil: 'domcontentloaded' });
        return { url: this.page.url() };
      case 'wait': {
        const ms = Math.min(
          typeof input.timeMs === 'number'
            ? input.timeMs
            : typeof input.ms === 'number'
              ? input.ms
              : 1000,
          10000
        );
        await this.page.waitForTimeout(ms);
        return { success: true, waited: ms };
      }
      case 'screenshot': {
        const outputPath = await this.artifactPath('agent-screenshot', 'png');
        const buffer = await this.page.screenshot({ path: outputPath, fullPage: false });
        return {
          success: true,
          base64: buffer.toString('base64'),
          path: outputPath,
          timestamp: Date.now(),
          pageUrl: this.page.url()
        };
      }
      case 'think':
        return {
          acknowledged: true,
          message: optionalString(input.reasoning) ?? requiredString(input, 'thought')
        };
      case 'done':
        return {
          success: Boolean(input.success ?? input.taskComplete),
          message: optionalString(input.message) ??
            optionalString(input.reasoning) ??
            'Task execution completed',
          output: input.output && typeof input.output === 'object'
            ? input.output as Record<string, unknown>
            : undefined
        };
      default:
        throw runtimeError('AI_AGENT_FAILED', `unsupported agent tool: ${name}`);
    }
  }

  private async completeObject<T>(
    config: VoleConfig,
    input: Omit<Parameters<RuntimeModelClient['generateObject']>[0], 'schema'> & {
      schema: z.ZodTypeAny;
    }
  ): Promise<ModelObjectResult<T>> {
    const model = this.getModel(config);
    if (model.generateObject) {
      return model.generateObject(input) as Promise<ModelObjectResult<T>>;
    }
    const startedAt = Date.now();
    const value = await model.completeJson(input) as T;
    return {
      value,
      structuredOutputMode: 'prompt',
      usage: {},
      finishReason: 'stop',
      warnings: [],
      durationMs: Date.now() - startedAt,
      providerMetadata: { synthetic: true }
    };
  }

  private async config(): Promise<VoleConfig> {
    this.configPromise ??= this.options.config
      ? Promise.resolve(this.options.config)
      : loadConfig(this.options.cwd ?? process.cwd());
    const config = await this.configPromise;
    if (!config.runtimeAi.enabled) {
      throw runtimeError('AI_RUNTIME_DISABLED', 'runtimeAi.enabled is false');
    }
    return config;
  }

  private async snapshot(selector?: string, ignoreSelectors: string[] = []): Promise<PageSnapshot> {
    const config = await this.config();
    if (
      typeof (this.page as unknown as { waitForLoadState?: unknown }).waitForLoadState === 'function' &&
      typeof (this.page as unknown as { evaluate?: unknown }).evaluate === 'function'
    ) {
      await waitForPageReady(this.page, config, 0);
      await waitForDomNetworkQuiet(this.page, config.pageReady.networkIdleTimeoutMs);
    }
    return this.captureSnapshot(selector, ignoreSelectors);
  }

  private async captureSnapshot(
    selector?: string,
    ignoreSelectors: string[] = []
  ): Promise<PageSnapshot> {
    const config = await this.config();
    this.snapshotter ??= new PageSnapshotter(this.page, config.runtimeAi.snapshotMaxChars);
    const snapshot = await this.snapshotter.capture(selector, ignoreSelectors);
    if (!selector && ignoreSelectors.length === 0) this.latestSnapshot = snapshot;
    return snapshot;
  }

  private getExecutor(): ActionExecutor {
    this.executor ??= new ActionExecutor(this.page);
    return this.executor;
  }

  private getModel(config: VoleConfig): RuntimeModel {
    this.model ??= this.options.model ?? new RuntimeModelClient(config, { logger: this.logger });
    return this.model;
  }

  private getCache(config: VoleConfig): AiRuntimeCache {
    this.cache ??= new AiRuntimeCache(path.resolve(
      this.options.cwd ?? process.cwd(),
      config.runtimeAi.cacheDir
    ));
    return this.cache;
  }

  private async artifact(kind: string, value: unknown): Promise<string> {
    const filePath = await this.artifactPath(kind, 'json');
    await writeFile(
      filePath,
      `${JSON.stringify(safeValue(redactEmbeddedVariables(value)), null, 2)}\n`,
      'utf8'
    );
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

function requiredString(input: Record<string, unknown>, key: string): string {
  return z.string().min(1).parse(input[key]);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalAction(value: unknown): AiActionMethod | undefined {
  return value === undefined ? undefined : actionMethodSchema.parse(value);
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

function isZodSchema<T>(value: unknown): value is z.ZodType<T> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'parse' in value &&
    typeof (value as { parse?: unknown }).parse === 'function'
  );
}

function isAiAction(value: unknown): value is AiAction {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'selector' in value &&
    typeof (value as { selector?: unknown }).selector === 'string'
  );
}

function isSupportedActionMethod(value: string): value is AiActionMethod {
  return SUPPORTED_ACTIONS.has(value);
}

type NormalizedActionPlan = {
  elementId: string;
  description: string;
  method: AiActionMethod;
  arguments: string[];
  twoStep: boolean;
};

function normalizeActionPlan(value: unknown): NormalizedActionPlan | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const rawAction = record.action === null
    ? undefined
    : record.action && typeof record.action === 'object'
      ? record.action as Record<string, unknown>
      : record;
  if (!rawAction) {
    return undefined;
  }
  const elementId = rawAction.elementId;
  const method = rawAction.method;
  if (
    typeof elementId !== 'string' ||
    !/^\d+-\d+$/u.test(elementId) ||
    typeof method !== 'string' ||
    !isSupportedActionMethod(method)
  ) {
    return undefined;
  }
  return {
    elementId,
    description: typeof rawAction.description === 'string'
      ? rawAction.description
      : typeof rawAction.reasoning === 'string'
        ? rawAction.reasoning
        : '',
    method,
    arguments: Array.isArray(rawAction.arguments)
      ? rawAction.arguments.filter((argument): argument is string =>
          typeof argument === 'string'
        )
      : [],
    twoStep: record.twoStep === true
  };
}

function buildActSystemPrompt(): string {
  return [
    'You are the element resolver for Vole: given a natural-language action and a hybrid DOM and accessibility snapshot of the page, decide which single element the action should target.',
    'Your inputs are an instruction that describes the desired action, and an indented outline of the semantic structure of the page.',
    'When an element matches the instruction, return that element. When nothing on the page fits, return action set to null.',
    'Never invent an element. elementId, description, and method must always refer to something present in the snapshot; blanks and placeholders are not allowed.',
    'Element identifiers have the shape frameOrdinal-backendNodeId. Reproduce the identifier character for character from the snapshot.'
  ].join(' ');
}

function buildActPrompt(
  input: AiActInput,
  variables?: AiVariables
): string {
  const supported = input.action
    ? [input.action]
    : INFERENCE_ACTION_METHODS;
  const variableNames = variablePromptEntries(variables)
    .map(({ name }) => `%${name}%`);
  const variablePrompt = variableNames.length > 0
    ? [
        `The caller supplied these variable names: ${variableNames.join(', ')}.`,
        'They are placeholders, not literal values.',
        'When an argument should use one, put the wrapped name (%name%) in the arguments array instead of the real value.'
      ].join(' ')
    : '';
  const suppliedValue = input.value !== undefined
    ? 'The caller attached a value to this action. Use that value for the chosen method and do not invent or echo it in the response.'
    : '';
  const suppliedFile = input.filePath !== undefined
    ? 'The caller attached a file path. Choose setInputFiles and do not invent or return the path itself.'
    : '';
  return `
Resolve one element and action for this instruction: ${input.instruction}.
${input.target ? `The caller named this target: ${input.target}.` : ''}
Apply the dropdown rules only when the instruction is explicitly about choosing an option from a dropdown.

Action contract:
- Emit one action whose method is one of: ${supported.join(', ')}.
- For a right or middle click, put right or middle as the first argument.
- When the instruction does not map to any action on this page, or nothing matches, set action to null. Do not invent an element.
- Express a scroll target as a percentage in the arguments, for example 50% or 75%.
- To move one viewport forward or back, choose nextChunk or prevChunk and pass no arguments.
- For a keystroke, choose press and give the precise key as the argument, for example Enter, Tab, Escape, Space, or a.

Dropdown rules:
- For a native select element, choose selectOptionFromDropdown, pass its exact option text, and set twoStep to false.
- For a custom dropdown that opens on click, choose the element that opens it and set twoStep to true.

${variablePrompt}
${suppliedValue}
${suppliedFile}
`.trim();
}

function buildActStepTwoPrompt(
  originalInstruction: string,
  previousAction: AiAction,
  variables?: AiVariables
): string {
  const variableNames = variablePromptEntries(variables)
    .map(({ name }) => `%${name}%`);
  return `
The original instruction was: ${originalInstruction}.
Step 1 of 2 is complete: method ${previousAction.method}; ${previousAction.description}; arguments ${(previousAction.arguments ?? []).join(', ')}.

Now resolve the single element and action that finish step 2 of 2.
Pick a method from: ${INFERENCE_ACTION_METHODS
    .filter((method) => method !== 'selectOptionFromDropdown')
    .join(', ')}.
Do not propose another two-step plan.
If nothing matches, set action to null instead of guessing.
${variableNames.length > 0
    ? `Variable names available: ${variableNames.join(', ')}. Return the wrapped placeholders, not their values.`
    : ''}
`.trim();
}

function buildActUserPrompt(instruction: string, snapshot: string): string {
  return `instruction: ${instruction}\n\npage outline:\n${snapshot}\n`;
}

type UrlPathSegment = string | '*';

function transformUrlSchema(
  schema: z.ZodTypeAny,
  path: UrlPathSegment[] = []
): { schema: z.ZodTypeAny; urlPaths: UrlPathSegment[][] } {
  if (schema instanceof z.ZodString) {
    const checks = (schema._def as { checks?: Array<{ kind?: string }> }).checks ?? [];
    if (checks.some((check) => check.kind === 'url')) {
      return {
        schema: schema.description ? z.string().describe(schema.description) : z.string(),
        urlPaths: [path]
      };
    }
    return { schema, urlPaths: [] };
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const urlPaths: UrlPathSegment[][] = [];
    const transformedShape = Object.fromEntries(
      Object.entries(shape).map(([key, child]) => {
        const transformed = transformUrlSchema(child as z.ZodTypeAny, [...path, key]);
        urlPaths.push(...transformed.urlPaths);
        return [key, transformed.schema];
      })
    );
    return { schema: z.object(transformedShape), urlPaths };
  }
  if (schema instanceof z.ZodArray) {
    const transformed = transformUrlSchema(schema.element, [...path, '*']);
    return { schema: z.array(transformed.schema), urlPaths: transformed.urlPaths };
  }
  if (schema instanceof z.ZodOptional) {
    const transformed = transformUrlSchema(schema.unwrap(), path);
    return { schema: transformed.schema.optional(), urlPaths: transformed.urlPaths };
  }
  if (schema instanceof z.ZodNullable) {
    const transformed = transformUrlSchema(schema.unwrap(), path);
    return { schema: transformed.schema.nullable(), urlPaths: transformed.urlPaths };
  }
  return { schema, urlPaths: [] };
}

function restoreUrlFields(
  value: unknown,
  paths: UrlPathSegment[][],
  urlMap: Record<string, string>,
  baseUrl: string
): unknown {
  let result = value;
  for (const path of paths) {
    result = restoreUrlPath(result, path, urlMap, baseUrl);
  }
  return result;
}

function restoreUrlPath(
  current: unknown,
  path: UrlPathSegment[],
  urlMap: Record<string, string>,
  baseUrl: string
): unknown {
  if (path.length === 0) {
    if (typeof current !== 'string' || !urlMap[current]) {
      return current;
    }
    try {
      return new URL(urlMap[current], baseUrl).toString();
    } catch {
      return urlMap[current];
    }
  }
  if (!current || typeof current !== 'object') {
    return current;
  }
  const [segment, ...rest] = path;
  if (segment === '*') {
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        current[index] = restoreUrlPath(current[index], rest, urlMap, baseUrl);
      }
    }
    return current;
  }
  const record = current as Record<string, unknown>;
  record[segment] = restoreUrlPath(record[segment], rest, urlMap, baseUrl);
  return current;
}

function attachResultMetadata(
  value: unknown,
  usage: ModelObjectResult<unknown>['usage'],
  completeness?: AiExtractCompleteness
): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  const descriptors: Record<string, PropertyDescriptor> = {
    cacheStatus: { value: 'MISS', enumerable: false },
    usage: { value: usage, enumerable: false }
  };
  if (completeness) {
    descriptors.completeness = { value: completeness, enumerable: false };
  }
  Object.defineProperties(value, descriptors);
  return value;
}

function isAgentInput(value: AiAgentInput | AiAgentConfig | undefined): value is AiAgentInput {
  return Boolean(
    value &&
    'instruction' in value &&
    typeof (value as { instruction?: unknown }).instruction === 'string'
  );
}

function normalizeAgentInput(input: string | AiAgentExecuteOptions): AiAgentInput {
  return typeof input === 'string' ? { instruction: input } : input;
}

function agentSystemPrompt(): string {
  return [
    'You are a bounded DOM browser automation agent operating an existing Playwright page.',
    'Use ariaTree for page grounding, use only supplied tools, and keep actions atomic.',
    'Never report success until ariaTree or extract has verified the final state.',
    'Call done exactly once when the goal is complete or impossible.'
  ].join(' ');
}

function agentPrompt(input: AiAgentInput, currentUrl: string): string {
  return JSON.stringify({
    goal: input.instruction,
    variables: variablePromptEntries(input.variables).map(({ name, description }) => ({
      placeholder: `%${name}%`,
      description
    })),
    currentUrl
  });
}

function agentCallPrompt(
  input: AiAgentInput,
  currentUrl: string
): { messages: NonNullable<AiAgentInput['messages']> } | { prompt: string } {
  if (input.messages?.length) {
    return {
      messages: [
        ...input.messages,
        { role: 'user', content: input.instruction }
      ]
    };
  }
  return { prompt: agentPrompt(input, currentUrl) };
}

function lastDone(
  history: AiAgentHistoryItem[]
): { success: boolean; message: string; output?: Record<string, unknown> } | undefined {
  const item = [...history].reverse().find((entry) => entry.tool === 'done');
  if (!item?.output || typeof item.output !== 'object') {
    return undefined;
  }
  const output = item.output as Record<string, unknown>;
  return {
    success: output.success === true,
    message: typeof output.message === 'string' ? output.message : 'Agent did not provide a final message',
    output: output.output && typeof output.output === 'object'
      ? output.output as Record<string, unknown>
      : undefined
  };
}

type JsonSchema = {
  type?: string | string[];
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  format?: string;
  description?: string;
};

function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  if (schema.enum?.length) {
    const literals = schema.enum.map((value) => z.literal(value));
    return literals.length === 1
      ? literals[0]!
      : z.union(literals as [z.ZodLiteral<unknown>, z.ZodLiteral<unknown>, ...z.ZodLiteral<unknown>[]]);
  }
  const rawType = Array.isArray(schema.type)
    ? schema.type.find((type) => type !== 'null')
    : schema.type;
  let result: z.ZodTypeAny;
  switch (rawType) {
    case 'object': {
      const required = new Set(schema.required ?? []);
      const shape = Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, child]) => {
          const childSchema = jsonSchemaToZod(child);
          return [key, required.has(key) ? childSchema : childSchema.optional()];
        })
      );
      result = z.object(shape).passthrough();
      break;
    }
    case 'array':
      result = z.array(jsonSchemaToZod(schema.items ?? {}));
      break;
    case 'integer':
      result = z.number().int();
      break;
    case 'number':
      result = z.number();
      break;
    case 'boolean':
      result = z.boolean();
      break;
    case 'null':
      result = z.null();
      break;
    case 'string':
      result = schema.format === 'uri' || schema.format === 'url'
        ? z.string().url()
        : z.string();
      break;
    default:
      result = z.unknown();
  }
  if (schema.description) {
    result = result.describe(schema.description);
  }
  return Array.isArray(schema.type) && schema.type.includes('null')
    ? result.nullable()
    : result;
}

function isReplayableAction(value: unknown): value is AiAction {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const action = value as Record<string, unknown>;
  return typeof action.selector === 'string' &&
    typeof action.description === 'string' &&
    (action.method === undefined || actionMethodSchema.safeParse(action.method).success);
}

function toRuntimeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}): AiAgentResult['usage'] {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens !== undefined && usage.outputTokens !== undefined
      ? usage.inputTokens + usage.outputTokens
      : undefined,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage.inputTokenDetails?.cacheWriteTokens
  };
}

const BUILT_IN_TOOL_META: Record<string, ToolKind> = {
  observe: 'verify',
  ariaTree: 'verify',
  assert: 'verify',
  extract: 'verify',
  act: 'mutate',
  fillForm: 'mutate',
  goto: 'mutate',
  keys: 'mutate',
  pressKey: 'mutate',
  scroll: 'mutate',
  navback: 'mutate',
  navBack: 'mutate',
  goBack: 'mutate',
  wait: 'mutate',
  done: 'neutral',
  think: 'neutral',
  screenshot: 'neutral'
};

function classifyTool(name: string, overrides?: Record<string, ToolKind>): ToolKind {
  return overrides?.[name] ?? BUILT_IN_TOOL_META[name] ?? 'neutral';
}

function verificationTool(name: string, overrides?: Record<string, ToolKind>): boolean {
  return classifyTool(name, overrides) === 'verify';
}

function verificationGateMessage(): string {
  const verifyTools = Object.keys(BUILT_IN_TOOL_META)
    .filter((name) => BUILT_IN_TOOL_META[name] === 'verify');
  return `Agent must verify the final state before reporting success. Call one of: ${
    verifyTools.join(', ')
  }. Then call done again.`;
}

// Agent tools that do not change the page snapshot. When the just-finished step
// only ran these, handleAgentStep reuses the previous observation instead of
// re-capturing a fresh DOM/AX snapshot + screenshot. Unknown and custom tools
// are treated as mutating (conservative) so a stale view is never served.
const NON_MUTATING_STEP_TOOLS = new Set([
  'think', 'screenshot', 'observe', 'ariaTree', 'extract', 'assert', 'done'
]);

function shouldTerminateAgentTool(error: unknown): boolean {
  if (error instanceof AiRuntimeError) {
    return error.code === 'AI_RUNTIME_TIMEOUT' ||
      (error.code === 'AI_AGENT_FAILED' && /cross-origin/iu.test(error.message));
  }
  return error instanceof Error &&
    /target page.*closed|browser.*closed|context.*closed/iu.test(error.message);
}

function normalizeAgentError(
  error: Error,
  history: AiAgentHistoryItem[]
): Error {
  if (error instanceof AiRuntimeError) {
    if (
      error.code === 'AI_AGENT_FAILED' &&
      history.length === 0 &&
      /without a successful done|stopped without|did not complete/iu.test(error.message)
    ) {
      return runtimeError(
        'AI_MODEL_CAPABILITY_UNSUPPORTED',
        'agent model did not call any DOM tool; verify that tool calling is supported'
      );
    }
    return error;
  }
  if (
    /tool(?:s|_choice| calling)?.*(?:not supported|unsupported|unavailable)|function calling.*(?:not supported|unsupported)/iu
      .test(error.message)
  ) {
    return runtimeError(
      'AI_MODEL_CAPABILITY_UNSUPPORTED',
      `agent model does not support required tool calling: ${error.message}`
    );
  }
  return runtimeError('AI_AGENT_FAILED', error.message, { history });
}

function transformHistoryVariables(
  history: AiAgentHistoryItem[],
  variables: AiVariables | undefined,
  mode: 'template' | 'hydrate'
): AiAgentHistoryItem[] {
  return history.map((item) => ({
    ...item,
    input: transformVariables(item.input, variables, mode),
    output: transformVariables(item.output, variables, mode)
  }));
}

function transformActionVariables(
  actions: AiAction[],
  variables: AiVariables | undefined,
  mode: 'template' | 'hydrate'
): AiAction[] {
  return actions.map((action) => ({
    ...action,
    description: transformVariables(action.description, variables, mode) as string,
    arguments: action.arguments?.map((argument) =>
      transformVariables(argument, variables, mode) as string
    )
  }));
}

function safeValue(value: unknown, key = ''): unknown {
  if (
    /(password|secret|api.?key|api.?token|access.?token|refresh.?token|authorization)/iu
      .test(key) ||
    /^token$/iu.test(key)
  ) {
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

export const runtimeTestExports = { safeValue };

function redactEmbeddedVariables(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactEmbeddedVariables(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const record = value as Record<string, unknown>;
  const variables = record.variables && typeof record.variables === 'object'
    ? record.variables as AiVariables
    : undefined;
  const transformed = variables
    ? transformVariables(record, variables, 'template') as Record<string, unknown>
    : record;
  return Object.fromEntries(
    Object.entries(transformed).map(([key, child]) => [
      key,
      redactEmbeddedVariables(child)
    ])
  );
}

function hasVerificationAfterLastMutation(
  history: AiAgentHistoryItem[],
  overrides?: Record<string, ToolKind>
): boolean {
  let lastVerification = -1;
  let lastMutation = -1;
  for (const [index, item] of history.entries()) {
    const kind = classifyTool(item.tool, overrides);
    if (kind === 'verify') {
      lastVerification = index;
    } else if (kind === 'mutate') {
      lastMutation = index;
    }
  }
  return lastVerification > lastMutation;
}

function transformVariables(
  value: unknown,
  variables: AiVariables | undefined,
  mode: 'template' | 'hydrate'
): unknown {
  if (typeof value === 'string') {
    if (mode === 'template') {
      return redactVariableValues(value, variables);
    }
    return substituteVariables(value, variables);
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

function snapshotDiff(before: PageSnapshot, after: PageSnapshot): string {
  const previousLines = new Set(
    before.text.split('\n').map((line) => line.trim()).filter(Boolean)
  );
  const added = after.text.split('\n').filter((line) => {
    const core = line.trim();
    return Boolean(core) && !previousLines.has(core);
  });
  if (added.length === 0) return '';
  const minIndent = Math.min(...added.map((line) => line.match(/^\s*/u)?.[0].length ?? 0));
  return added.map((line) => line.slice(minIndent)).join('\n');
}

function actionableSnapshotNode(
  snapshot: PageSnapshot,
  elementId: string | undefined
): SnapshotNode | undefined {
  if (!elementId) return undefined;
  const node = snapshot.nodes.find((candidate) => candidate.elementId === elementId);
  if (!node?.xpath) return node;
  const actionableXpath = node.xpath.replace(/\/text\(\)(?:\[\d+\])?$/iu, '');
  if (actionableXpath === node.xpath) return node;
  const parent = snapshot.nodes.find((candidate) => candidate.xpath === actionableXpath);
  if (parent) return parent;
  return {
    ...node,
    xpath: actionableXpath,
    locators: node.locators.map((locator) =>
      locator.strategy === 'xpath' ? { ...locator, value: actionableXpath } : locator
    )
  };
}

function mergeUsage(
  left: ModelObjectResult<unknown>['usage'],
  right?: ModelObjectResult<unknown>['usage']
): ModelObjectResult<unknown>['usage'] {
  if (!right) {
    return left;
  }
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens),
    reasoningTokens: add(left.reasoningTokens, right.reasoningTokens),
    cachedInputTokens: add(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteTokens: add(left.cacheWriteTokens, right.cacheWriteTokens)
  };
}

type ActDeadline = {
  ensure(): void;
  remaining(): number;
};

function createActDeadline(timeoutMs: number): ActDeadline {
  const startedAt = Date.now();
  const enabled = timeoutMs > 0;
  const ensure = (): void => {
    if (enabled && Date.now() - startedAt >= timeoutMs) {
      throw runtimeError('AI_RUNTIME_TIMEOUT', `act timed out after ${timeoutMs}ms`);
    }
  };
  return {
    ensure,
    remaining: () => {
      ensure();
      return enabled ? Math.max(1, timeoutMs - (Date.now() - startedAt)) : 2_147_483_647;
    }
  };
}

function successfulDeterministicResult(
  method: AiActionMethod,
  locator: LocatorDescriptor,
  action: AiAction,
  selfHealed: boolean
): AiActResult {
  return {
    success: true,
    message: `Action [${method}] performed successfully on selector: ${action.selector}`,
    actionDescription: action.description || `action (${method})`,
    actions: [action],
    action: method,
    locator,
    fromCache: false,
    selfHealed,
    cacheStatus: 'MISS'
  };
}

function failedDeterministicResult(
  method: string,
  description: string | undefined,
  message: string,
  usage?: ModelObjectResult<unknown>['usage']
): AiActResult {
  return {
    success: false,
    message,
    actionDescription: description || `action (${method})`,
    actions: [],
    action: isSupportedActionMethod(method) ? method : undefined,
    fromCache: false,
    selfHealed: false,
    cacheStatus: 'MISS',
    usage
  };
}

function rethrowActTimeout(error: unknown): void {
  if (error instanceof AiRuntimeError && error.code === 'AI_RUNTIME_TIMEOUT') {
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function actionsChanged(original: AiAction[], current: AiAction[]): boolean {
  if (original.length !== current.length) {
    return true;
  }
  return original.some((action, index) => {
    const next = current[index];
    return !next ||
      action.selector !== next.selector ||
      action.description !== next.description ||
      (action.method ?? '') !== (next.method ?? '') ||
      JSON.stringify(action.arguments ?? []) !== JSON.stringify(next.arguments ?? []);
  });
}
