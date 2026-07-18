import type { z } from 'zod';
import type { AiPwConfig } from '../config/schema.js';
import { runtimeError } from './errors.js';

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

type ChatCompletionPayload = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: ModelToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: {
    message?: string;
  };
};

export class RuntimeModelClient {
  constructor(private readonly config: AiPwConfig) {}

  async completeJson<T>(input: {
    purpose: string;
    system: string;
    user: unknown;
    schema: z.ZodType<T>;
    timeoutMs?: number;
  }): Promise<T> {
    const response = await this.request(
      [
        {
          role: 'system',
          content: `${input.system}\nReturn one valid JSON value only. Do not return Markdown.`
        },
        {
          role: 'user',
          content: JSON.stringify(input.user)
        }
      ],
      undefined,
      input.timeoutMs
    );

    const content = response.content;
    if (!content) {
      throw runtimeError('AI_MODEL_INVALID_RESPONSE', `${input.purpose}: model returned empty content`);
    }

    try {
      return input.schema.parse(JSON.parse(extractJson(content)));
    } catch (error) {
      throw runtimeError(
        'AI_MODEL_INVALID_RESPONSE',
        `${input.purpose}: response did not match the required schema`,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async completeWithTools(
    messages: ModelMessage[],
    tools: ModelTool[],
    timeoutMs?: number
  ): Promise<{ content: string | null; toolCalls: ModelToolCall[] }> {
    const response = await this.request(messages, tools, timeoutMs);
    if (response.toolCalls.length === 0 && !response.content) {
      throw runtimeError(
        'AI_MODEL_CAPABILITY_UNSUPPORTED',
        'the configured model returned neither a tool call nor a final response'
      );
    }
    return response;
  }

  private async request(
    messages: ModelMessage[],
    tools?: ModelTool[],
    timeoutMs?: number
  ): Promise<{ content: string | null; toolCalls: ModelToolCall[] }> {
    const apiKey = resolveApiKey(this.config);
    if (!apiKey) {
      throw runtimeError(
        'AI_MODEL_REQUEST_FAILED',
        `environment variable ${this.config.ai.apiKeyEnv ?? '(not configured)'} is not set`
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.config.runtimeAi.timeoutMs
    );

    try {
      const response = await retry(this.config.ai.maxRetries, async () => {
        const result = await fetch(
          `${this.config.ai.baseURL.replace(/\/$/, '')}/chat/completions`,
          {
            method: 'POST',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${apiKey}`,
              'content-type': 'application/json'
            },
            body: JSON.stringify({
              model: this.config.runtimeAi.model ?? this.config.ai.model,
              temperature: this.config.ai.temperature,
              messages,
              ...(tools ? { tools, tool_choice: 'auto' } : {})
            })
          }
        );

        const payload = (await result.json()) as ChatCompletionPayload;
        if (!result.ok) {
          throw new Error(payload.error?.message ?? result.statusText);
        }
        return payload;
      });

      const message = response.choices?.[0]?.message;
      return {
        content: message?.content ?? null,
        toolCalls: message?.tool_calls ?? []
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw runtimeError('AI_RUNTIME_TIMEOUT', 'model request timed out');
      }
      if (error instanceof Error && error.message.startsWith('AI_')) {
        throw error;
      }
      throw runtimeError(
        'AI_MODEL_REQUEST_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveApiKey(config: AiPwConfig): string | undefined {
  if (config.ai.apiKey) {
    return config.ai.apiKey;
  }
  if (!config.ai.apiKeyEnv) {
    return undefined;
  }
  const environmentValue = process.env[config.ai.apiKeyEnv];
  if (environmentValue) {
    return environmentValue;
  }
  return /^[A-Z_][A-Z0-9_]*$/u.test(config.ai.apiKeyEnv)
    ? undefined
    : config.ai.apiKeyEnv;
}

async function retry<T>(maxRetries: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  if (fenced?.[1]) {
    return fenced[1];
  }
  const objectStart = content.indexOf('{');
  const arrayStart = content.indexOf('[');
  const start = [objectStart, arrayStart].filter((value) => value >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) {
    return content;
  }
  const closing = content[start] === '[' ? ']' : '}';
  const end = content.lastIndexOf(closing);
  return end > start ? content.slice(start, end + 1) : content;
}
