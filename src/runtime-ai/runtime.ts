import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import {
  ToolLoopAgent,
  hasToolCall,
  stepCountIs,
  tool as aiTool,
  type StepResult,
  type ToolSet
} from 'ai';
import { z } from 'zod';
import { loadConfig } from '../config/load-config.js';
import type { VoleConfig } from '../config/schema.js';
import { waitForPageReady } from '../playwright/page-readiness.js';
import { ensureDir } from '../utils/fs.js';
import { ActionExecutor } from './action-executor.js';
import { AiRuntimeCache, redactVariableValues } from './cache.js';
import { AiRuntimeError, runtimeError } from './errors.js';
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
  AiObserveOptions,
  AiVariables,
  ExtractSchema,
  LocatorDescriptor,
  PageSnapshot
} from './types.js';

const actionMethodSchema = z.enum([
  'click',
  'fill',
  'type',
  'selectOption',
  'selectOptionFromDropdown',
  'setInputFiles',
  'press',
  'hover',
  'doubleClick',
  'scrollTo',
  'nextChunk',
  'prevChunk',
  'dragAndDrop'
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
  elementId: z.string().min(1).nullable(),
  method: actionMethodSchema,
  arguments: z.array(z.string()).default([]),
  reasoning: z.string().default(''),
  twoStep: z.boolean().default(false)
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

type RuntimeModel = Pick<RuntimeModelClient, 'completeJson' | 'completeWithTools'> &
  Partial<Pick<RuntimeModelClient, 'generateObject' | 'generateText' | 'getLanguageModel'>>;

export type CreateAiRuntimeOptions = {
  cwd?: string;
  config?: VoleConfig;
  model?: RuntimeModel;
};

export class AiRuntime {
  private configPromise?: Promise<VoleConfig>;
  private snapshotter?: PageSnapshotter;
  private executor?: ActionExecutor;
  private model?: RuntimeModel;
  private cache?: AiRuntimeCache;

  constructor(
    private readonly page: Page,
    private readonly options: CreateAiRuntimeOptions = {}
  ) {}

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
      const node = snapshot.nodes.find((item) => item.elementId === candidate.elementId);
      const locator = node?.locators[0];
      if (!node || !locator) {
        return [];
      }
      const argumentsWithResolvedTargets = candidate.method === 'dragAndDrop' &&
        candidate.arguments?.[0]
        ? (() => {
            const target = snapshot.nodes.find(
              (item) => item.elementId === candidate.arguments[0]
            );
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
    const config = await this.config();
    const snapshot = await this.snapshot(options.selector, options.ignoreSelectors);
    if (!instruction || !schema) {
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
    return attachResultMetadata(
      restoreUrlFields(
        response.value,
        transformedSchema.urlPaths,
        snapshot.urlMap,
        snapshot.url
      ),
      response.usage
    ) as T;
  }

  async act(input: AiActInput): Promise<AiActResult>;
  async act(input: string, options?: AiActOptions): Promise<AiActResult>;
  async act(input: AiAction, options?: AiActOptions): Promise<AiActResult>;
  async act(
    rawInput: AiActInput | string | AiAction,
    options: AiActOptions = {}
  ): Promise<AiActResult> {
    if (isAiAction(rawInput)) {
      return this.replayActionWithHealing(rawInput, options);
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
    const config = await this.config();
    const timeoutMs = input.timeoutMs ?? config.runtimeAi.timeoutMs;
    const firstSnapshot = await this.snapshot();
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

    if (
      cached &&
      (!input.action || cached.action === input.action) &&
      await this.getExecutor().isUsable(cached.locator)
    ) {
      try {
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
        for (const [index, cachedAction] of cachedActions.entries()) {
          await this.getExecutor().execute({
            method: cachedAction.method ?? cached.action,
            locator: cachedAction.locator ??
              this.getExecutor().descriptorFromSelector(cachedAction.selector),
            value: substituteVariables(
              input.value ?? cachedAction.arguments?.[0] ?? '',
              input.variables
            ),
            filePath: input.filePath,
            targetLocator: cachedAction.method === 'dragAndDrop' && cachedAction.arguments?.[0]
              ? this.getExecutor().descriptorFromSelector(
                  substituteVariables(cachedAction.arguments[0], input.variables)
                )
              : undefined,
            timeoutMs
          });
          if (index < cachedActions.length - 1) {
            await this.page.waitForTimeout(100);
          }
        }
        const result: AiActResult = {
          success: true,
          message: 'Action completed from cache',
          actionDescription: cached.actions?.[0]?.description ?? input.instruction,
          actions: cachedActions,
          action: cached.action,
          locator: cached.locator,
          fromCache: true,
          selfHealed: false,
          cacheStatus: 'HIT'
        };
        await this.tryArtifact('act', { input, result });
        return result;
      } catch {
        // A fresh snapshot and model plan below provide one self-healing attempt.
      }
    }

    try {
      const result = await this.planAndExecute(input, firstSnapshot, timeoutMs);
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
      return result;
    } catch (firstError) {
      if (!config.runtimeAi.selfHeal) {
        throw this.wrapActError(firstError);
      }
      try {
        const freshSnapshot = await this.snapshot();
        const result = await this.planAndExecute(input, freshSnapshot, timeoutMs);
        const healed = { ...result, selfHealed: true };
        if (useCache && healed.success && healed.action && healed.locator) {
          await cache.set({
            key,
            instruction: cacheInstruction,
            url: freshSnapshot.url,
            pageFingerprint: freshSnapshot.fingerprint,
            model: input.model ?? config.runtimeAi.model ?? config.ai.model,
            variableNames: Object.keys(input.variables ?? {}).sort(),
            action: healed.action,
            locator: healed.locator,
            actions: transformActionVariables(healed.actions, input.variables, 'template')
          }).catch(() => undefined);
        }
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

  private async runSdkAgent(
    input: AiAgentInput,
    agentConfig: AiAgentConfig,
    config: VoleConfig,
    model: RuntimeModelClient
  ): Promise<AiAgentResult> {
    const history: AiAgentHistoryItem[] = [];
    const maxSteps = input.maxSteps ?? config.runtimeAi.agent.maxSteps;
    const startedAt = Date.now();
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
            agentConfig.executionModel
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
          return result;
        } catch {
          await cache.deleteAgentTrajectory(cacheKey);
        }
      }
    }

    const tools = this.createSdkAgentTools(
      input,
      config,
      history,
      agentConfig.tools,
      agentConfig.executionModel,
      agentConfig.excludeTools
    );
    const loop = new ToolLoopAgent({
      model: model.getLanguageModel(modelName),
      instructions: agentConfig.systemPrompt ?? agentSystemPrompt(),
      tools,
      stopWhen: [hasToolCall('done'), stepCountIs(maxSteps)],
      prepareStep: input.callbacks?.prepareStep,
      onStepFinish: (event) => this.handleAgentStep(input, event),
      providerOptions: input.providerOptions
    });

    try {
      const generated = await loop.generate({
        ...agentCallPrompt(input, this.page.url()),
        abortSignal: input.abortSignal,
        timeout: input.timeoutMs ?? config.runtimeAi.agent.timeoutMs
      });
      let done = lastDone(history);
      if (!done) {
        const forcedTools = this.createSdkAgentTools(
          input,
          config,
          history,
          undefined,
          agentConfig.executionModel,
          agentConfig.excludeTools
        );
        const finalizer = new ToolLoopAgent({
          model: model.getLanguageModel(modelName),
          instructions: 'Call done once. Report success only when the supplied history proves the goal.',
          tools: { done: forcedTools.done },
          toolChoice: { type: 'tool', toolName: 'done' },
          stopWhen: hasToolCall('done'),
          providerOptions: input.providerOptions
        });
        await finalizer.generate({
          prompt: JSON.stringify({
            goal: input.instruction,
            history: safeValue(history)
          }),
          abortSignal: input.abortSignal,
          timeout: Math.min(
            input.timeoutMs ?? config.runtimeAi.agent.timeoutMs,
            config.runtimeAi.agent.toolTimeoutMs
          )
        });
        done = lastDone(history);
      }
      if (!done?.success) {
        throw runtimeError(
          'AI_AGENT_FAILED',
          done?.message ?? 'agent stopped without a successful done result',
          { history }
        );
      }

      const output = done.output;
      const result: AiAgentResult = {
        success: true,
        message: done.message,
        steps: history.length,
        history,
        actions: history,
        completed: true,
        usage: {
          ...toRuntimeUsage(generated.usage),
          inferenceTimeMs: Date.now() - startedAt
        },
        messages: [
          ...(input.messages ?? []),
          ...(input.messages?.length
            ? [{ role: 'user' as const, content: input.instruction }]
            : []),
          ...generated.responseMessages
        ],
        output,
        cacheStatus: 'MISS',
        selfHealed: false
      };
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
      return result;
    } catch (error) {
      const mapped = error instanceof Error ? error : new Error(String(error));
      const terminalError = normalizeAgentError(mapped, history);
      if (input.abortSignal?.aborted) {
        await input.callbacks?.onAbort?.();
      } else {
        await input.callbacks?.onError?.(terminalError);
      }
      const artifactPath = await this.tryArtifact('agent-failed', {
        input,
        history,
        error: terminalError.message
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
    const history: AiAgentHistoryItem[] = [];
    const modelName = agentConfig.model ?? config.runtimeAi.model ?? config.ai.model;
    const maxSteps = input.maxSteps ?? config.runtimeAi.agent.maxSteps;
    const startedAt = Date.now();
    const tools = this.createSdkAgentTools(
      input,
      config,
      history,
      agentConfig.tools,
      agentConfig.executionModel,
      agentConfig.excludeTools
    );
    const loop = new ToolLoopAgent({
      model: model.getLanguageModel(modelName),
      instructions: agentConfig.systemPrompt ?? agentSystemPrompt(),
      tools,
      stopWhen: [
        hasToolCall('done'),
        stepCountIs(maxSteps)
      ],
      prepareStep: input.callbacks?.prepareStep,
      onStepFinish: (event) => this.handleAgentStep(input, event),
      providerOptions: input.providerOptions
    });
    let streamed: Awaited<ReturnType<typeof loop.stream>>;
    try {
      streamed = await loop.stream({
        ...agentCallPrompt(input, this.page.url()),
        abortSignal: input.abortSignal,
        timeout: input.timeoutMs ?? config.runtimeAi.agent.timeoutMs
      });
    } catch (error) {
      const mapped = error instanceof Error ? error : new Error(String(error));
      const terminalError = normalizeAgentError(mapped, history);
      if (input.abortSignal?.aborted) {
        await input.callbacks?.onAbort?.();
      } else {
        await input.callbacks?.onError?.(terminalError);
      }
      throw terminalError;
    }
    const result = (async (): Promise<AiAgentResult> => {
      try {
        const [usage, responseMessages] = await Promise.all([
          streamed.usage,
          streamed.responseMessages
        ]);
        let done = lastDone(history);
        if (!done) {
          const forcedTools = this.createSdkAgentTools(
            input,
            config,
            history,
            undefined,
            agentConfig.executionModel,
            agentConfig.excludeTools
          );
          const finalizer = new ToolLoopAgent({
            model: model.getLanguageModel!(modelName),
            instructions: 'Call done once based only on the verified streaming agent history.',
            tools: { done: forcedTools.done },
            toolChoice: { type: 'tool', toolName: 'done' },
            stopWhen: hasToolCall('done'),
            providerOptions: input.providerOptions
          });
          await finalizer.generate({
            prompt: JSON.stringify({ goal: input.instruction, history: safeValue(history) }),
            abortSignal: input.abortSignal,
            timeout: config.runtimeAi.agent.toolTimeoutMs
          });
          done = lastDone(history);
        }
        if (!done?.success) {
          throw runtimeError(
            'AI_AGENT_FAILED',
            done?.message ?? 'streaming agent did not complete',
            { history }
          );
        }
        const output = done.output;
        const value: AiAgentResult = {
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
          output,
          cacheStatus: 'MISS',
          selfHealed: false
        };
        await input.callbacks?.onEvidence?.({ type: 'final', data: value });
        await input.callbacks?.onFinish?.(value);
        return value;
      } catch (error) {
        const mapped = error instanceof Error ? error : new Error(String(error));
        const terminalError = normalizeAgentError(mapped, history);
        if (input.abortSignal?.aborted) {
          await input.callbacks?.onAbort?.();
        } else {
          await input.callbacks?.onError?.(terminalError);
        }
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
    excludeTools: string[] = []
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
          : verificationTool(name)
            ? 'observation'
            : 'action',
        step: item.step,
        data: item
      });
      return output;
    };
    const execute = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      let output: unknown;
      try {
        output = name === 'done' &&
          Boolean(input.success ?? input.taskComplete) &&
          !hasVerificationAfterLastMutation(history)
          ? { success: false, message: 'Agent must verify the final state before reporting success' }
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
      return recordResult(name, input, output);
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
    executionModel?: string
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
    if (!hasVerificationAfterLastMutation(history)) {
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
          results.push(await this.replayAction(action, {
            variables: input.variables,
            model: executionModel
          }));
        }
        return {
          success: results.every((result) => result.success),
          actions: results.flatMap((result) => result.actions),
          fromCache: true,
          selfHealed: false
        };
      } catch {
        // The DOM changed. Fall through to semantic act so the trajectory can heal.
      }
    }
    const healed = await this.executeAgentTool('act', toolInput, input, config, executionModel);
    return healed && typeof healed === 'object'
      ? { ...(healed as Record<string, unknown>), fromCache: true, selfHealed: true }
      : healed;
  }

  private async handleAgentStep(
    input: AiAgentInput,
    event: StepResult<ToolSet, Record<string, unknown>>
  ): Promise<void> {
    await input.callbacks?.onStepFinish?.(event);
    if (!input.callbacks?.onEvidence) {
      return;
    }
    let observation: unknown;
    try {
      const snapshot = await this.snapshot();
      const screenshot = await this.page.screenshot({ fullPage: false });
      observation = {
        url: snapshot.url,
        tree: snapshot.text,
        screenshotBase64: screenshot.toString('base64')
      };
    } catch (error) {
      observation = {
        url: this.page.url(),
        error: error instanceof Error ? error.message : String(error)
      };
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
  }

  private async planAndExecute(
    input: AiActInput,
    snapshot: PageSnapshot,
    timeoutMs: number
  ): Promise<AiActResult> {
    const config = await this.config();
    const response = await this.completeObject<z.infer<typeof actionPlanSchema>>(config, {
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
        variables: variablePromptEntries(input.variables).map(({ name, description }) => ({
          placeholder: `%${name}%`,
          description
        })),
        snapshot: snapshot.text
      },
      schema: actionPlanSchema,
      timeoutMs,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions,
      model: input.model
    });
    const plan = response.value;
    if (!plan.elementId) {
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
    const dragTargetNode = action === 'dragAndDrop'
      ? snapshot.nodes.find((item) => item.elementId === plan.arguments?.[0])
      : undefined;
    const dragTargetLocator = dragTargetNode?.locators[0];
    await this.getExecutor().execute({
      method: action,
      locator,
      value: substituteVariables(input.value ?? plan.arguments?.[0] ?? '', input.variables),
      filePath: input.filePath,
      targetLocator: dragTargetLocator,
      timeoutMs
    });
    const description = plan.reasoning || input.instruction;
    const actions: AiAction[] = [{
      selector: this.getExecutor().selector(locator),
      description,
      method: action,
      locator,
      arguments: action === 'dragAndDrop' && dragTargetNode && dragTargetLocator
        ? [
            dragTargetNode.xpath
              ? `xpath=${dragTargetNode.xpath}`
              : this.getExecutor().selector(dragTargetLocator)
          ]
        : plan.arguments
    }];
    let finalAction = action;
    let finalLocator = locator;
    let usage = response.usage;
    if (plan.twoStep) {
      const secondSnapshot = await this.snapshot();
      const secondResponse = await this.completeObject<z.infer<typeof actionPlanSchema>>(config, {
        purpose: 'act-second-step',
        system: [
          'Complete the second and final step of a two-step browser action.',
          'Use exactly one elementId from the fresh snapshot.',
          'Do not return another two-step plan.'
        ].join(' '),
        user: {
          instruction: input.instruction,
          target: input.target,
          valueAvailable: input.value !== undefined,
          snapshot: snapshotDiff(snapshot, secondSnapshot)
        },
        schema: actionPlanSchema,
        timeoutMs,
        abortSignal: input.abortSignal,
        providerOptions: input.providerOptions,
        model: input.model
      });
      usage = mergeUsage(usage, secondResponse.usage);
      const secondPlan = secondResponse.value;
      if (!secondPlan.elementId) {
        return {
          success: true,
          message: 'First action completed; no second action was found',
          actionDescription: description,
          actions,
          action,
          locator,
          fromCache: false,
          selfHealed: false,
          cacheStatus: 'MISS',
          usage
        };
      }
      const secondNode = secondSnapshot.nodes.find((item) => item.elementId === secondPlan.elementId);
      const secondLocator = secondNode?.locators[0];
      if (!secondNode || !secondLocator) {
        throw runtimeError('AI_ACT_FAILED', `second step selected unknown element ${secondPlan.elementId}`);
      }
      await this.getExecutor().execute({
        method: secondPlan.method,
        locator: secondLocator,
        value: substituteVariables(
          input.value ?? secondPlan.arguments?.[0] ?? '',
          input.variables
        ),
        timeoutMs
      });
      finalAction = secondPlan.method;
      finalLocator = secondLocator;
      actions.push({
        selector: this.getExecutor().selector(secondLocator),
        description: secondPlan.reasoning || `Complete ${input.instruction}`,
        method: secondPlan.method,
        locator: secondLocator,
        arguments: secondPlan.arguments
      });
    }
    return {
      success: true,
      message: 'Action completed',
      actionDescription: description,
      actions,
      action: finalAction,
      locator: finalLocator,
      fromCache: false,
      selfHealed: false,
      cacheStatus: 'MISS',
      usage
    };
  }

  private async replayAction(action: AiAction, options: AiActOptions): Promise<AiActResult> {
    const config = await this.config();
    const method = action.method ?? 'click';
    const locator = action.locator ?? this.getExecutor().descriptorFromSelector(action.selector);
    const timeoutMs = options.timeoutMs ?? config.runtimeAi.timeoutMs;
    await this.getExecutor().execute({
      method,
      locator,
      value: substituteVariables(action.arguments?.[0] ?? '', options.variables),
      targetLocator: method === 'dragAndDrop' && action.arguments?.[0]
        ? this.getExecutor().descriptorFromSelector(
            substituteVariables(action.arguments[0], options.variables)
          )
        : undefined,
      timeoutMs
    });
    return {
      success: true,
      message: 'Deterministic action replay completed',
      actionDescription: action.description,
      actions: [action],
      action: method,
      locator,
      fromCache: false,
      selfHealed: false,
      cacheStatus: 'MISS'
    };
  }

  private async replayActionWithHealing(
    action: AiAction,
    options: AiActOptions
  ): Promise<AiActResult> {
    try {
      return await this.replayAction(action, options);
    } catch (firstError) {
      const config = await this.config();
      if (!config.runtimeAi.selfHeal) {
        throw this.wrapActError(firstError);
      }
      try {
        const snapshot = await this.snapshot();
        const result = await this.planAndExecute({
          instruction: action.description,
          action: action.method,
          value: action.arguments?.[0],
          variables: options.variables,
          timeoutMs: options.timeoutMs,
          model: options.model,
          cache: options.cache,
          abortSignal: options.abortSignal,
          providerOptions: options.providerOptions
        }, snapshot, options.timeoutMs ?? config.runtimeAi.timeoutMs);
        return { ...result, selfHealed: true };
      } catch (secondError) {
        throw this.wrapActError(secondError, firstError);
      }
    }
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
    return {
      value: await model.completeJson(input) as T,
      structuredOutputMode: 'prompt',
      usage: {},
      finishReason: 'stop',
      warnings: [],
      durationMs: 0
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
    }
    this.snapshotter ??= new PageSnapshotter(this.page, config.runtimeAi.snapshotMaxChars);
    return this.snapshotter.capture(selector, ignoreSelectors);
  }

  private getExecutor(): ActionExecutor {
    this.executor ??= new ActionExecutor(this.page);
    return this.executor;
  }

  private getModel(config: VoleConfig): RuntimeModel {
    this.model ??= this.options.model ?? new RuntimeModelClient(config);
    return this.model;
  }

  private getCache(config: VoleConfig): AiRuntimeCache {
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
  usage: ModelObjectResult<unknown>['usage']
): unknown {
  if (!value || typeof value !== 'object') {
    return value;
  }
  Object.defineProperties(value, {
    cacheStatus: { value: 'MISS', enumerable: false },
    usage: { value: usage, enumerable: false }
  });
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

function verificationTool(name: string): boolean {
  return ['observe', 'ariaTree', 'assert', 'extract'].includes(name);
}

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
    /(password|secret|api.?key|api.?token|access.?token|refresh.?token|authorization|base64)/iu
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

function hasVerificationAfterLastMutation(history: AiAgentHistoryItem[]): boolean {
  const verificationTools = new Set(['observe', 'ariaTree', 'assert', 'extract']);
  const nonMutationTools = new Set(['done', 'think', 'screenshot']);
  let lastVerification = -1;
  let lastMutation = -1;
  for (const [index, item] of history.entries()) {
    if (verificationTools.has(item.tool)) {
      lastVerification = index;
    }
    if (!verificationTools.has(item.tool) && !nonMutationTools.has(item.tool)) {
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
  const previous = new Map(
    before.nodes.map((node) => [
      node.elementId,
      JSON.stringify([node.tag, node.role, node.name, node.value, node.disabled])
    ])
  );
  const changedIds = new Set(
    after.nodes
      .filter((node) => previous.get(node.elementId) !==
        JSON.stringify([node.tag, node.role, node.name, node.value, node.disabled]))
      .map((node) => node.elementId)
  );
  const changedLines = after.text
    .split('\n')
    .filter((line) => {
      const match = line.match(/^\[([^\]]+)\]/u);
      return !match || (match[1] ? changedIds.has(match[1]) : false);
    });
  return changedIds.size > 0 ? changedLines.join('\n') : after.text;
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
