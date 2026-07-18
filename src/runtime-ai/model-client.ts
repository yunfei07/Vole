import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  Output,
  dynamicTool,
  extractJsonMiddleware,
  generateText,
  jsonSchema,
  streamText,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage as AiSdkModelMessage,
  type ToolSet
} from 'ai';
import { z } from 'zod';
import type { VoleConfig } from '../config/schema.js';
import { runtimeError } from './errors.js';
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
};

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ProviderOptions = Record<string, Record<string, JsonValue>>;

const promptModeModels = new Set<string>();

export class RuntimeModelClient {
  private readonly nativeProvider;
  private readonly promptProvider;
  private readonly callHistory: ModelCallLog[] = [];

  constructor(
    private readonly config: VoleConfig,
    options: ModelClientOptions = {}
  ) {
    const common = {
      name: 'vole',
      baseURL: config.ai.baseURL.replace(/\/$/, ''),
      apiKey: resolveApiKey(config),
      includeUsage: true,
      ...(options.fetch ? { fetch: options.fetch } : {})
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
      ? (promptModeModels.has(cacheKey) ? 'prompt' : 'native')
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
        throw mapModelError(error, input.purpose);
      }
      promptModeModels.add(cacheKey);
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
          { type: 'text' as const, text: JSON.stringify(input.user) },
          {
            type: 'image' as const,
            image: input.image.data,
            mediaType: input.image.mediaType
          }
        ]
      : JSON.stringify(input.user);
    const wrapOutput =
      (input.schema._def as { typeName?: z.ZodFirstPartyTypeKind }).typeName !==
      z.ZodFirstPartyTypeKind.ZodObject;
    const outputSchema = wrapOutput
      ? z.object({ result: input.schema })
      : input.schema;
    const result = await generateText({
      model,
      system: [
        input.system,
        mode === 'prompt' ? 'Return exactly one JSON value matching the requested schema.' : ''
      ].filter(Boolean).join('\n'),
      messages: [{ role: 'user', content: userContent }],
      output: Output.object<unknown>({
        schema: outputSchema as z.ZodTypeAny,
        name: safeSchemaName(input.purpose),
        description: `Structured result for ${input.purpose}`
      }),
      temperature: this.config.ai.temperature,
      maxRetries: this.config.ai.maxRetries,
      timeout: input.timeoutMs ?? this.config.ai.timeoutMs,
      abortSignal: input.abortSignal,
      providerOptions: input.providerOptions
    });
    return {
      value: (wrapOutput
        ? (result.output as { result: T }).result
        : result.output) as T,
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
  if (variable && !/^[A-Z_][A-Z0-9_]*$/u.test(variable)) {
    return variable;
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
  if (error instanceof Error && error.message.startsWith('AI_')) {
    return error;
  }
  return runtimeError(
    'AI_MODEL_REQUEST_FAILED',
    `${purpose}: ${error instanceof Error ? error.message : String(error)}`
  );
}

function isCancellation(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'AbortError' || /abort|timeout/iu.test(error.message));
}

function shouldFallbackToPrompt(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /structured|response.?format|json.?schema|schema validation|no object|invalid json/iu.test(message);
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
