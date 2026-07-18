import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { ToolLoopAgent, hasToolCall, stepCountIs, tool as aiTool, type ToolSet } from 'ai';
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
  type ModelObjectResult,
  type ModelMessage,
  type ModelTool,
  type ModelToolCall
} from './model-client.js';
import { PageSnapshotter } from './snapshot.js';
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
  elementId: z.string().min(1),
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
        variableNames: Object.keys(options.variables ?? {}),
        snapshot: snapshot.text
      },
      schema: observeResponseSchema,
      timeoutMs: options.timeoutMs,
      model: options.model
    });

    const candidates = response.value.candidates.flatMap((candidate) => {
      const node = snapshot.nodes.find((item) => item.elementId === candidate.elementId);
      const locator = node?.locators[0];
      if (!node || !locator) {
        return [];
      }
      return [{
        ...candidate,
        method: candidate.method as AiActionMethod,
        arguments: candidate.arguments ?? [],
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
      ? await this.page.screenshot({ fullPage: false, type: 'jpeg', quality: 70 })
      : undefined;
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
      schema: schema as z.ZodType<unknown>,
      timeoutMs: options.timeoutMs,
      model: options.model,
      image: screenshot
        ? { data: new Uint8Array(screenshot), mediaType: 'image/jpeg' }
        : undefined
    });
    return attachResultMetadata(
      replaceElementUrls(response.value, snapshot.urlMap, snapshot.url),
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
      return this.replayAction(rawInput, options);
    }
    const input: AiActInput = typeof rawInput === 'string'
      ? {
          instruction: rawInput,
          variables: options.variables,
          timeoutMs: options.timeoutMs,
          model: options.model
        }
      : rawInput;
    const config = await this.config();
    const timeoutMs = input.timeoutMs ?? config.runtimeAi.timeoutMs;
    const firstSnapshot = await this.snapshot();
    const cache = this.getCache(config);
    const cacheInstruction = redactVariableValues(input.instruction, input.variables);
    const key = cache.createKey({
      instruction: input.instruction,
      url: firstSnapshot.url,
      pageFingerprint: firstSnapshot.fingerprint,
      model: input.model ?? config.runtimeAi.model ?? config.ai.model,
      variables: input.variables
    });
    const cached = await cache.get(key);

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
            locator: this.getExecutor().descriptorFromSelector(cachedAction.selector),
            value: input.value ?? cachedAction.arguments?.[0],
            filePath: input.filePath,
            targetLocator: cachedAction.method === 'dragAndDrop' && cachedAction.arguments?.[0]
              ? this.getExecutor().descriptorFromSelector(cachedAction.arguments[0])
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
      await cache.set({
        key,
        instruction: cacheInstruction,
        url: firstSnapshot.url,
        pageFingerprint: firstSnapshot.fingerprint,
        model: input.model ?? config.runtimeAi.model ?? config.ai.model,
        variableNames: Object.keys(input.variables ?? {}).sort(),
        action: result.action!,
        locator: result.locator!,
        actions: transformActionVariables(result.actions, input.variables, 'template')
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
          model: input.model ?? config.runtimeAi.model ?? config.ai.model,
          variableNames: Object.keys(input.variables ?? {}).sort(),
          action: healed.action!,
          locator: healed.locator!,
          actions: transformActionVariables(healed.actions, input.variables, 'template')
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
    return model.getLanguageModel
      ? this.runSdkAgent(input, agentConfig, config, model as RuntimeModelClient)
      : this.runLegacyAgent(input);
  }

  private async runLegacyAgent(input: AiAgentInput): Promise<AiAgentResult> {
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
            history,
            actions: history,
            completed: true
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
    const configSignature = JSON.stringify({
      mode: 'dom',
      model: modelName,
      executionModel: agentConfig.executionModel,
      maxSteps,
      customTools: Object.keys(agentConfig.tools ?? {}).sort(),
      sameOriginOnly: config.runtimeAi.agent.sameOriginOnly
    });
    const cacheKey = cache.createKey({
      instruction: `agent-trajectory\n${input.instruction}\n${configSignature}`,
      url: initialSnapshot.url,
      pageFingerprint: initialSnapshot.fingerprint,
      model: modelName,
      variables: input.variables
    });
    if (!agentConfig.tools) {
      const cached = await cache.getAgentTrajectory(cacheKey);
      if (cached) {
        try {
          const replayed = await this.replayTrajectory(cached.history, input, config);
          const result: AiAgentResult = {
            success: true,
            message: cached.resultMessage,
            steps: replayed.length,
            history: replayed,
            actions: replayed,
            completed: true
          };
          await input.callbacks?.onFinish?.(result);
          return result;
        } catch {
          await cache.deleteAgentTrajectory(cacheKey);
        }
      }
    }

    const tools = this.createSdkAgentTools(input, config, history, agentConfig.tools);
    const loop = new ToolLoopAgent({
      model: model.getLanguageModel(modelName),
      instructions: agentConfig.systemPrompt ?? agentSystemPrompt(),
      tools,
      stopWhen: [hasToolCall('done'), stepCountIs(maxSteps)],
      prepareStep: input.callbacks?.prepareStep
    });

    try {
      const generated = await loop.generate({
        ...(input.messages?.length
          ? { messages: input.messages }
          : { prompt: agentPrompt(input, this.page.url()) }),
        abortSignal: input.abortSignal,
        timeout: input.timeoutMs ?? config.runtimeAi.agent.timeoutMs
      });
      let done = lastDone(history);
      if (!done) {
        const forcedTools = this.createSdkAgentTools(input, config, history);
        const finalizer = new ToolLoopAgent({
          model: model.getLanguageModel(modelName),
          instructions: 'Call done once. Report success only when the supplied history proves the goal.',
          tools: { done: forcedTools.done },
          toolChoice: { type: 'tool', toolName: 'done' },
          stopWhen: hasToolCall('done')
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

      const output = input.output
        ? (await this.completeObject<Record<string, unknown>>(config, {
            purpose: 'agent-output',
            system: 'Extract the requested final output from verified agent history. Do not invent values.',
            user: { goal: input.instruction, history: safeValue(history) },
            schema: input.output,
            timeoutMs: input.timeoutMs,
            model: modelName
          })).value
        : undefined;
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
        messages: generated.responseMessages as typeof input.messages,
        output
      };
      if (!agentConfig.tools) {
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
      if (input.abortSignal?.aborted) {
        await input.callbacks?.onAbort?.();
      } else {
        await input.callbacks?.onError?.(mapped);
      }
      const artifactPath = await this.tryArtifact('agent-failed', {
        input,
        history,
        error: mapped.message
      });
      throw runtimeError('AI_AGENT_FAILED', `${mapped.message}; artifact=${artifactPath}`, { history });
    }
  }

  private async streamAgent(
    input: AiAgentInput,
    agentConfig: AiAgentConfig
  ): Promise<{ textStream: AsyncIterable<string>; result: Promise<AiAgentResult> }> {
    const config = await this.config();
    const model = this.getModel(config);
    if (!model.getLanguageModel) {
      const result = this.runLegacyAgent(input);
      return {
        textStream: (async function* () {
          yield (await result).message;
        })(),
        result
      };
    }
    const history: AiAgentHistoryItem[] = [];
    const modelName = agentConfig.model ?? config.runtimeAi.model ?? config.ai.model;
    const startedAt = Date.now();
    const tools = this.createSdkAgentTools(input, config, history, agentConfig.tools);
    const loop = new ToolLoopAgent({
      model: model.getLanguageModel(modelName),
      instructions: agentConfig.systemPrompt ?? agentSystemPrompt(),
      tools,
      stopWhen: [
        hasToolCall('done'),
        stepCountIs(input.maxSteps ?? config.runtimeAi.agent.maxSteps)
      ],
      prepareStep: input.callbacks?.prepareStep
    });
    const streamed = await loop.stream({
      ...(input.messages?.length
        ? { messages: input.messages }
        : { prompt: agentPrompt(input, this.page.url()) }),
      abortSignal: input.abortSignal,
      timeout: input.timeoutMs ?? config.runtimeAi.agent.timeoutMs
    });
    const textStream = this.withChunkCallback(streamed.textStream, input);
    const result = (async (): Promise<AiAgentResult> => {
      const [usage, responseMessages] = await Promise.all([
        streamed.usage,
        streamed.responseMessages
      ]);
      let done = lastDone(history);
      if (!done) {
        const forcedTools = this.createSdkAgentTools(input, config, history);
        const finalizer = new ToolLoopAgent({
          model: model.getLanguageModel!(modelName),
          instructions: 'Call done once based only on the verified streaming agent history.',
          tools: { done: forcedTools.done },
          toolChoice: { type: 'tool', toolName: 'done' },
          stopWhen: hasToolCall('done')
        });
        await finalizer.generate({
          prompt: JSON.stringify({ goal: input.instruction, history: safeValue(history) }),
          abortSignal: input.abortSignal,
          timeout: config.runtimeAi.agent.toolTimeoutMs
        });
        done = lastDone(history);
      }
      if (!done?.success) {
        throw runtimeError('AI_AGENT_FAILED', done?.message ?? 'streaming agent did not complete', { history });
      }
      const output = input.output
        ? (await this.completeObject<Record<string, unknown>>(config, {
            purpose: 'agent-stream-output',
            system: 'Extract the requested final output from verified agent history.',
            user: { goal: input.instruction, history: safeValue(history) },
            schema: input.output,
            timeoutMs: input.timeoutMs,
            model: modelName
          })).value
        : undefined;
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
        messages: responseMessages as typeof input.messages,
        output
      };
      await input.callbacks?.onFinish?.(value);
      return value;
    })();
    return { textStream, result };
  }

  private createSdkAgentTools(
    agentInput: AiAgentInput,
    config: VoleConfig,
    history: AiAgentHistoryItem[],
    customTools?: ToolSet
  ): ToolSet {
    const execute = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
      let output: unknown;
      try {
        output = name === 'done' &&
          Boolean(input.success) &&
          !hasVerificationAfterLastMutation(history)
          ? { success: false, message: 'Agent must verify the final state before reporting success' }
          : await withTimeout(
              this.executeAgentTool(name, input, agentInput, config),
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
      const item: AiAgentHistoryItem = {
        step: history.length + 1,
        tool: name,
        input: safeValue(input),
        output: safeValue(output)
      };
      history.push(item);
      await agentInput.callbacks?.onStepFinish?.(item);
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
    const tools: ToolSet = {
      observe: aiTool({
        description: 'Find relevant actionable elements on the current page',
        inputSchema: z.object({ instruction: z.string().min(1) }),
        execute: (input) => execute('observe', input)
      }),
      ariaTree: aiTool({
        description: 'Read the current page DOM/accessibility tree',
        inputSchema: z.object({}),
        execute: (input) => execute('ariaTree', input)
      }),
      act: aiTool({
        description: 'Perform one grounded browser action',
        inputSchema: z.object({
          instruction: z.string().min(1),
          action: actionMethodSchema.optional(),
          target: z.string().optional(),
          value: z.string().optional()
        }),
        execute: (input) => execute('act', input)
      }),
      assert: aiTool({
        description: 'Verify browser state using deterministic and semantic evidence',
        inputSchema: z.object({
          instruction: z.string().min(1),
          kind: z.enum(['visible', 'hidden', 'text', 'containsText', 'enabled', 'disabled', 'semantic']),
          target: z.string().optional(),
          expected: z.string().optional()
        }),
        execute: (input) => execute('assert', input)
      }),
      extract: aiTool({
        description: 'Extract concise structured facts from the page',
        inputSchema: z.object({ instruction: z.string().min(1) }),
        execute: (input) => execute('extract', input)
      }),
      fillForm: aiTool({
        description: 'Fill several form fields',
        inputSchema: z.object({
          fields: z.array(z.object({ target: z.string().min(1), value: z.string() }))
        }),
        execute: (input) => execute('fillForm', input)
      }),
      goto: aiTool({
        description: 'Navigate to a same-origin URL',
        inputSchema: z.object({ url: z.string().min(1) }),
        execute: (input) => execute('goto', input)
      }),
      keys: aiTool({
        description: 'Press a keyboard key or chord',
        inputSchema: z.object({ key: z.string().min(1) }),
        execute: (input) => execute('keys', input)
      }),
      navBack: aiTool({
        description: 'Navigate back one page',
        inputSchema: z.object({}),
        execute: (input) => execute('navBack', input)
      }),
      screenshot: aiTool({
        description: 'Capture viewport evidence',
        inputSchema: z.object({}),
        execute: (input) => execute('screenshot', input)
      }),
      scroll: aiTool({
        description: 'Scroll the current page',
        inputSchema: z.object({
          direction: z.enum(['up', 'down']),
          amount: z.number().positive().max(5000).optional()
        }),
        execute: (input) => execute('scroll', input)
      }),
      think: aiTool({
        description: 'Record a concise plan without changing the page',
        inputSchema: z.object({ thought: z.string().min(1) }),
        execute: (input) => execute('think', input)
      }),
      wait: aiTool({
        description: 'Wait briefly for asynchronous UI updates',
        inputSchema: z.object({ ms: z.number().int().positive().max(10000) }),
        execute: (input) => execute('wait', input)
      }),
      done: aiTool({
        description: 'Finish only after the final state was verified',
        inputSchema: z.object({ success: z.boolean(), message: z.string().min(1) }),
        execute: (input) => execute('done', input)
      }),
      ...customTools
    };
    return tools;
  }

  private async replayTrajectory(
    cachedHistory: AiAgentHistoryItem[],
    input: AiAgentInput,
    config: VoleConfig
  ): Promise<AiAgentHistoryItem[]> {
    const history: AiAgentHistoryItem[] = [];
    for (const item of transformHistoryVariables(cachedHistory, input.variables, 'hydrate')) {
      if (item.tool === 'done') {
        continue;
      }
      const toolInput = z.record(z.unknown()).parse(item.input);
      const output = await this.executeAgentTool(item.tool, toolInput, input, config);
      history.push({
        step: history.length + 1,
        tool: item.tool,
        input: safeValue(toolInput),
        output: safeValue(output)
      });
    }
    if (!hasVerificationAfterLastMutation(history)) {
      throw runtimeError('AI_AGENT_FAILED', 'cached trajectory did not verify the final state');
    }
    return history;
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
        variableNames: Object.keys(input.variables ?? {}),
        snapshot: snapshot.text
      },
      schema: actionPlanSchema,
      timeoutMs,
      model: input.model
    });
    const plan = response.value;
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
      value: input.value ?? plan.arguments?.[0],
      filePath: input.filePath,
      targetLocator: dragTargetLocator,
      timeoutMs
    });
    const description = plan.reasoning || input.instruction;
    const actions: AiAction[] = [{
      selector: this.getExecutor().selector(locator),
      description,
      method: action,
      arguments: action === 'dragAndDrop' && dragTargetNode && dragTargetLocator
        ? [
            this.getExecutor().selector(dragTargetLocator)
          ]
        : plan.arguments
    }];
    let finalAction = action;
    let finalLocator = locator;
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
          snapshot: secondSnapshot.text
        },
        schema: actionPlanSchema,
        timeoutMs,
        model: input.model
      });
      const secondPlan = secondResponse.value;
      const secondNode = secondSnapshot.nodes.find((item) => item.elementId === secondPlan.elementId);
      const secondLocator = secondNode?.locators[0];
      if (!secondNode || !secondLocator) {
        throw runtimeError('AI_ACT_FAILED', `second step selected unknown element ${secondPlan.elementId}`);
      }
      await this.getExecutor().execute({
        method: secondPlan.method,
        locator: secondLocator,
        value: input.value ?? secondPlan.arguments?.[0],
        timeoutMs
      });
      finalAction = secondPlan.method;
      finalLocator = secondLocator;
      actions.push({
        selector: this.getExecutor().selector(secondLocator),
        description: secondPlan.reasoning || `Complete ${input.instruction}`,
        method: secondPlan.method,
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
      usage: response.usage
    };
  }

  private async replayAction(action: AiAction, options: AiActOptions): Promise<AiActResult> {
    const config = await this.config();
    const method = action.method ?? 'click';
    const locator = this.getExecutor().descriptorFromSelector(action.selector);
    const timeoutMs = options.timeoutMs ?? config.runtimeAi.timeoutMs;
    await this.getExecutor().execute({
      method,
      locator,
      value: action.arguments?.[0],
      targetLocator: method === 'dragAndDrop' && action.arguments?.[0]
        ? this.getExecutor().descriptorFromSelector(action.arguments[0])
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

  private async executeAgentTool(
    name: string,
    input: Record<string, unknown>,
    agentInput: AiAgentInput,
    config: VoleConfig
  ): Promise<unknown> {
    switch (name) {
      case 'observe':
        return this.observe(requiredString(input, 'instruction'), {
          variables: agentInput.variables
        });
      case 'ariaTree':
        return this.extract();
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
      case 'keys':
      case 'pressKey': {
        const key = requiredString(input, 'key');
        await this.page.keyboard.press(key);
        return { key };
      }
      case 'navBack':
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

function replaceElementUrls(value: unknown, urlMap: Record<string, string>, baseUrl: string): unknown {
  if (typeof value === 'string' && urlMap[value]) {
    try {
      return new URL(urlMap[value], baseUrl).toString();
    } catch {
      return urlMap[value];
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceElementUrls(item, urlMap, baseUrl));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        replaceElementUrls(item, urlMap, baseUrl)
      ])
    );
  }
  return value;
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
    'Ground actions with observe or ariaTree, use only supplied tools, and keep actions atomic.',
    'Never report success until observe, extract, or assert has verified the final state.',
    'Call done exactly once when the goal is complete or impossible.'
  ].join(' ');
}

function agentPrompt(input: AiAgentInput, currentUrl: string): string {
  return JSON.stringify({
    goal: input.instruction,
    variableNames: Object.keys(input.variables ?? {}),
    currentUrl
  });
}

function lastDone(history: AiAgentHistoryItem[]): { success: boolean; message: string } | undefined {
  const item = [...history].reverse().find((entry) => entry.tool === 'done');
  if (!item?.output || typeof item.output !== 'object') {
    return undefined;
  }
  const output = item.output as Record<string, unknown>;
  return {
    success: output.success === true,
    message: typeof output.message === 'string' ? output.message : 'Agent did not provide a final message'
  };
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

function transformHistoryVariables(
  history: AiAgentHistoryItem[],
  variables: Record<string, string> | undefined,
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
  variables: Record<string, string> | undefined,
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
  const verificationTools = new Set(['observe', 'ariaTree', 'assert', 'extract']);
  const mutationTools = new Set([
    'act',
    'fillForm',
    'goto',
    'scroll',
    'keys',
    'navBack',
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
