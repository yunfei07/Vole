import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  Output,
  dynamicTool,
  extractJsonMiddleware,
  generateText,
  jsonSchema,
  streamText,
  wrapLanguageModel,
  zodSchema,
  type LanguageModel,
  type ModelMessage as AiSdkModelMessage,
  type ToolSet
} from 'ai';
import { z } from 'zod';
import type { VoleConfig } from '../config/schema.js';
import { runtimeLogger } from '../logging/context.js';
import { hashSensitiveText, type VoleLogger } from '../logging/logger.js';
import { AiRuntimeError, isCancellation, runtimeError } from './errors.js';
import type { RuntimeModelUsage } from './types.js';

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ModelToolCall[];
};

export type ModelTool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ModelCallMetadata = {
  usage: RuntimeModelUsage;
  finishReason: string;
  warnings: unknown[];
  providerMetadata?: unknown;
  responseId?: string;
  responseModel?: string;
  durationMs: number;
};

export type ModelObjectResult<T> = ModelCallMetadata & {
  value: T;
  structuredOutputMode: 'native' | 'prompt';
};

export type ModelTextResult = ModelCallMetadata & {
  text: string;
  toolCalls: ModelToolCall[];
  responseMessages: unknown[];
};

export type ModelCallLog = {
  purpose: string;
  model: string;
  kind: 'object' | 'text';
  metadata: ModelCallMetadata;
  structuredOutputMode?: 'native' | 'prompt';
  timestamp: string;
};

type ModelClientOptions = {
  fetch?: typeof globalThis.fetch;
  logger?: VoleLogger;
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ProviderOptions = Record<string, Record<string, JsonValue>>;

/**
 * Build the `fetch` passed to the openai-compatible provider. When reasoning
 * (`config.runtimeAi.thinking`) is configured, every chat-completion request
 * body gets a `thinking: { type }` field injected. This is the only knob some
 * providers honor (e.g. ZhipuAI GLM-4.7 on the openai-compatible endpoint,
 * which defaults to thinking ENABLED and ignores OpenAI's `reasoning_effort`);
 * injecting it explicitly keeps act/observe/extract inference fast instead of
 * generating thousands of reasoning tokens. Provider-agnostic: bodies that are
 * not JSON chat requests are forwarded unchanged.
 */
function resolveFetch(
  config: VoleConfig,
  options: ModelClientOptions
): { fetch?: typeof globalThis.fetch } {
  const thinking = config.runtimeAi.thinking;
  if (!thinking) {
    return options.fetch ? { fetch: options.fetch } : {};
  }
  const baseFetch = options.fetch ?? globalThis.fetch;
  return { fetch: createThinkingFetch(thinking, baseFetch) };
}

function createThinkingFetch(
  thinking: 'enabled' | 'disabled',
  baseFetch: typeof globalThis.fetch
): typeof globalThis.fetch {
  return async (input, init) => {
    const body = init?.body;
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body) as { messages?: unknown; thinking?: unknown };
        if (parsed && typeof parsed === 'object' && 'messages' in parsed) {
          parsed.thinking = { type: thinking };
          init = { ...init, body: JSON.stringify(parsed) };
        }
      } catch {
        // body is not JSON; forward unchanged
      }
    }
    return baseFetch(input, init);
  };
}

export const modelClientTestExports = { createThinkingFetch };

export class RuntimeModelClient {
  private readonly nativeProvider;
  private readonly promptProvider;
  private readonly callHistory: ModelCallLog[] = [];
  private readonly promptModeModels = new Set<string>();
  private readonly logger: VoleLogger;

  constructor(
    private readonly config: VoleConfig,
    options: ModelClientOptions = {}
  ) {
    this.logger = runtimeLogger(options.logger).child({ component: 'ai-model' });
    const common = {
      name: 'vole',
      baseURL: config.ai.baseURL.replace(/\/$/, ''),
      apiKey: resolveApiKey(config),
      includeUsage: true,
      ...resolveFetch(config, options)
    };
    this.nativeProvider = createOpenAICompatible({
      ...common,
      supportsStructuredOutputs: true
    });
    this.promptProvider = createOpenAICompatible({
      ...common,
      supportsStructuredOutputs: false
    });
  }

  getLanguageModel(modelName?: string): LanguageModel {
    return this.nativeProvider.chatModel(modelName ?? this.modelName());
  }

  getCallHistory(): readonly ModelCallLog[] {
    return this.callHistory;
  }

  async generateObject<T>(input: {
    purpose: string;
    system: string;
    user: unknown;
    schema: z.ZodType<T>;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    model?: string;
    providerOptions?: ProviderOptions;
    image?: { data: Uint8Array; mediaType: string };
  }): Promise<ModelObjectResult<T>> {
    const modelName = input.model ?? this.modelName();
    const configuredMode = this.config.ai.structuredOutputMode;
    const cacheKey = `${this.config.ai.baseURL}:${modelName}`;
    const preferredMode = configuredMode === 'auto'
      ? (this.promptModeModels.has(cacheKey) ? 'prompt' : 'native')
      : configuredMode;

    try {
      const result = await this.runObject(input, modelName, preferredMode);
      this.record({
        purpose: input.purpose,
        model: modelName,
        kind: 'object',
        metadata: metadataOnly(result),
        structuredOutputMode: result.structuredOutputMode,
        timestamp: new Date().toISOString()
      });
      return result;
    } catch (error) {
      if (
        configuredMode !== 'auto' ||
        preferredMode === 'prompt' ||
        isCancellation(error) ||
        !shouldFallbackToPrompt(error)
      ) {
        this.logFailure(input.purpose, modelName, error);
        throw mapModelError(error, input.purpose);
      }
      this.logger.warn('ai.model_structured_output_fallback', {
        message: 'Model structured output is incompatible; retrying in prompt mode',
        purpose: input.purpose,
        model: modelName
      });
      this.promptModeModels.add(cacheKey);
      try {
        const result = await this.runObject(input, modelName, 'prompt');
        this.record({
          purpose: input.purpose,
          model: modelName,
          kind: 'object',
          metadata: metadataOnly(result),
          structuredOutputMode: result.structuredOutputMode,
          timestamp: new Date().toISOString()
        });
        return result;
      } catch (fallbackError) {
        this.logFailure(input.purpose, modelName, fallbackError);
        throw mapModelError(fallbackError, input.purpose);
      }
    }
  }

  async generateText(input: {
    system: string;
    messages?: AiSdkModelMessage[];
    prompt?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    model?: string;
    providerOptions?: ProviderOptions;
    tools?: ToolSet;
  }): Promise<ModelTextResult> {
    const startedAt = Date.now();
    try {
      const result = await generateText({
        model: this.getLanguageModel(input.model),
        system: input.system,
        ...(input.messages ? { messages: input.messages } : { prompt: input.prompt ?? '' }),
        ...(input.tools ? { tools: input.tools } : {}),
        toolChoice: input.tools ? 'auto' : undefined,
        temperature: this.config.ai.temperature,
        maxRetries: this.config.ai.maxRetries,
        timeout: input.timeoutMs ?? this.config.ai.timeoutMs,
        abortSignal: input.abortSignal,
        providerOptions: input.providerOptions
      });
      const value: ModelTextResult = {
        text: result.text,
        toolCalls: result.toolCalls.map((call) => ({
          id: call.toolCallId,
          type: 'function',
          function: {
            name: call.toolName,
            arguments: JSON.stringify(call.input ?? {})
          }
        })),
        responseMessages: result.responseMessages,
        ...metadata(result, startedAt)
      };
      this.record({
        purpose: 'generateText',
        model: input.model ?? this.modelName(),
        kind: 'text',
        metadata: metadataOnly(value),
        timestamp: new Date().toISOString()
      });
      return value;
    } catch (error) {
      this.logFailure('generateText', input.model ?? this.modelName(), error);
      throw mapModelError(error, 'generateText');
    }
  }

  stream(input: {
    system: string;
    messages?: AiSdkModelMessage[];
    prompt?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
    model?: string;
    providerOptions?: ProviderOptions;
    tools?: ToolSet;
  }): ReturnType<typeof streamText> {
    return streamText({
      model: this.getLanguageModel(input.model),
      system: input.system,
      ...(input.messages ? { messages: input.messages } : { prompt: input.prompt ?? '' }),
      ...(input.tools ? { tools: input.tools } : {}),
      toolChoice: input.tools ? 'auto' : undefined,
      temperature: this.config.ai.temperature,
      maxRetries: this.config.ai.maxRetries,
      timeout: input.timeoutMs ?? this.config.ai.timeoutMs,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions
    });
  }

  async completeJson<T>(input: {
    purpose: string;
    system: string;
    user: unknown;
    schema: z.ZodType<T>;
    timeoutMs?: number;
  }): Promise<T> {
    return (await this.generateObject(input)).value;
  }

  async completeWithTools(
    messages: ModelMessage[],
    tools: ModelTool[],
    timeoutMs?: number
  ): Promise<{ content: string | null; toolCalls: ModelToolCall[]; usage?: RuntimeModelUsage }> {
    const toolSet = Object.fromEntries(tools.map((definition) => [
      definition.function.name,
      dynamicTool({
        description: definition.function.description,
        inputSchema: jsonSchema(definition.function.parameters)
      })
    ]));
    const converted = convertMessages(messages);
    const result = await this.generateText({
      system: converted.system,
      messages: converted.messages,
      tools: toolSet,
      timeoutMs
    });
    if (result.toolCalls.length === 0 && !result.text) {
      throw runtimeError(
        'AI_MODEL_CAPABILITY_UNSUPPORTED',
        'the configured model returned neither a tool call nor a final response'
      );
    }
    return {
      content: result.text || null,
      toolCalls: result.toolCalls,
      usage: result.usage
    };
  }

  private async runObject<T>(
    input: {
      purpose: string;
      system: string;
      user: unknown;
      schema: z.ZodType<T>;
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      providerOptions?: ProviderOptions;
      image?: { data: Uint8Array; mediaType: string };
    },
    modelName: string,
    mode: 'native' | 'prompt'
  ): Promise<ModelObjectResult<T>> {
    const startedAt = Date.now();
    const baseModel = mode === 'native'
      ? this.nativeProvider.chatModel(modelName)
      : this.promptProvider.chatModel(modelName);
    const model = mode === 'prompt'
      ? wrapLanguageModel({ model: baseModel, middleware: extractJsonMiddleware() })
      : baseModel;
    const userContent = input.image
      ? [
          {
            type: 'text' as const,
            text: typeof input.user === 'string'
              ? input.user
              : JSON.stringify(input.user)
          },
          {
            type: 'image' as const,
            image: input.image.data,
            mediaType: input.image.mediaType
          }
        ]
      : typeof input.user === 'string'
        ? input.user
        : JSON.stringify(input.user);
    const wrapOutput =
      (input.schema._def as { typeName?: z.ZodFirstPartyTypeKind }).typeName !==
      z.ZodFirstPartyTypeKind.ZodObject;
    const outputSchema = wrapOutput
      ? z.object({ result: input.schema })
      : input.schema;
    const promptSchema = mode === 'prompt'
      ? await zodSchema(outputSchema as z.ZodTypeAny).jsonSchema
      : undefined;
    const outputName = safeSchemaName(input.purpose);
    const outputDescription = `Structured result for ${input.purpose}`;
    const result = await generateText({
      model,
      system: [
        input.system,
        mode === 'prompt'
          ? `Return exactly one JSON value matching this JSON Schema: ${JSON.stringify(promptSchema)}`
          : ''
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: userContent }],
      output: mode === 'prompt'
        ? Output.json({ name: outputName, description: outputDescription })
        : Output.object<unknown>({
            schema: outputSchema as z.ZodTypeAny,
            name: outputName,
            description: outputDescription
          }),
      temperature: this.config.ai.temperature,
      ...(input.purpose === 'act' || input.purpose === 'act-second-step'
        ? {
            topP: 1,
            frequencyPenalty: 0,
            presencePenalty: 0
          }
        : {}),
      maxRetries: this.config.ai.maxRetries,
      timeout: input.timeoutMs ?? this.config.ai.timeoutMs,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions
    });
    const validatedOutput = mode === 'prompt'
      ? outputSchema.parse(result.output)
      : result.output;
    return {
      value: (wrapOutput
        ? (validatedOutput as { result: T }).result
        : validatedOutput) as T,
      structuredOutputMode: mode,
      ...metadata(result, startedAt)
    };
  }

  private modelName(): string {
    return this.config.runtimeAi.model ?? this.config.ai.model;
  }

  private record(entry: ModelCallLog): void {
    this.callHistory.push(entry);
    if (this.callHistory.length > 100) {
      this.callHistory.splice(0, this.callHistory.length - 100);
    }
    this.logger.info('ai.model_completed', {
      purpose: entry.purpose,
      model: entry.model,
      kind: entry.kind,
      structuredOutputMode: entry.structuredOutputMode,
      durationMs: entry.metadata.durationMs,
      finishReason: entry.metadata.finishReason,
      warningCount: entry.metadata.warnings.length,
      usage: entry.metadata.usage,
      responseId: entry.metadata.responseId,
      responseModel: entry.metadata.responseModel
    });
  }

  private logFailure(purpose: string, model: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error('ai.model_failed', {
      message: 'AI model request failed',
      purpose,
      model,
      errorName: error instanceof Error ? error.name : 'Error',
      errorCode: error && typeof error === 'object' && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined,
      errorMessageHash: hashSensitiveText(message)
    });
  }
}

function convertMessages(messages: ModelMessage[]): {
  system: string;
  messages: AiSdkModelMessage[];
} {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .join('\n');
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      toolNames.set(call.id, call.function.name);
    }
  }

  const converted: AiSdkModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      continue;
    }
    if (message.role === 'user') {
      converted.push({ role: 'user', content: message.content ?? '' });
      continue;
    }
    if (message.role === 'assistant') {
      const content: Array<
        { type: 'text'; text: string } |
        { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (message.content) {
        content.push({ type: 'text', text: message.content });
      }
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.function.name,
          input: parseJson(call.function.arguments)
        });
      }
      converted.push({ role: 'assistant', content });
      continue;
    }
    const toolCallId = message.tool_call_id ?? 'unknown-tool-call';
    converted.push({
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId,
        toolName: toolNames.get(toolCallId) ?? 'unknown',
        output: { type: 'json', value: asJsonValue(parseJson(message.content ?? 'null')) }
      }]
    });
  }
  return { system, messages: converted };
}

function metadata(
  result: {
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
      outputTokenDetails?: { reasoningTokens?: number };
    };
    finishReason: string;
    warnings?: unknown[];
    providerMetadata?: unknown;
    response?: { id?: string; modelId?: string };
  },
  startedAt: number
): ModelCallMetadata {
  const inputTokens = result.usage.inputTokens;
  const outputTokens = result.usage.outputTokens;
  return {
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined,
      reasoningTokens: result.usage.outputTokenDetails?.reasoningTokens,
      cachedInputTokens: result.usage.inputTokenDetails?.cacheReadTokens,
      cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens
    },
    finishReason: result.finishReason,
    warnings: result.warnings ?? [],
    providerMetadata: result.providerMetadata,
    responseId: result.response?.id,
    responseModel: result.response?.modelId,
    durationMs: Date.now() - startedAt
  };
}

function metadataOnly(value: ModelCallMetadata): ModelCallMetadata {
  return {
    usage: { ...value.usage },
    finishReason: value.finishReason,
    warnings: [...value.warnings],
    providerMetadata: value.providerMetadata,
    responseId: value.responseId,
    responseModel: value.responseModel,
    durationMs: value.durationMs
  };
}

function resolveApiKey(config: VoleConfig): string {
  if (config.ai.apiKey) {
    return config.ai.apiKey;
  }
  const variable = config.ai.apiKeyEnv;
  const value = variable ? process.env[variable] : undefined;
  if (value) {
    return value;
  }
  throw runtimeError(
    'AI_MODEL_REQUEST_FAILED',
    `environment variable ${variable ?? '(not configured)'} is not set`
  );
}

function mapModelError(error: unknown, purpose: string): Error {
  if (error instanceof Error && error.name === 'AbortError') {
    return runtimeError('AI_RUNTIME_TIMEOUT', `${purpose}: model request was aborted or timed out`);
  }
  if (error instanceof AiRuntimeError) {
    return error;
  }
  return runtimeError(
    'AI_MODEL_REQUEST_FAILED',
    `${purpose}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function shouldFallbackToPrompt(error: unknown): boolean {
  if (error instanceof Error) {
    if (/NoObjectGenerated|TypeValidation|StructuredOutput|ResponseFormat|JSONSchema/iu.test(error.name)) {
      return true;
    }
    return /structured|response.?format|json.?schema|schema validation|no object|invalid json/iu.test(error.message);
  }
  return false;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { value };
  }
}

function asJsonValue(value: unknown): JsonValue {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function safeSchemaName(purpose: string): string {
  const name = purpose.replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, 64);
  return name || 'vole_output';
}
