import type { z } from 'zod';
import type { AiPwConfig } from '../config/schema.js';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export type AiJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function requestAiJson<T>(
  config: AiPwConfig,
  input: {
    purpose: string;
    system: string;
    user: unknown;
    schema: z.ZodType<T>;
  }
): Promise<AiJsonResult<T>> {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    const message = `${input.purpose}: ai api key is not configured`;
    if (!config.aiEnhancements.failOpen) {
      throw new Error(message);
    }
    return { ok: false, error: message };
  }

  try {
    const response = await retry(config.aiEnhancements.maxRetries, () =>
      requestRawJson(config, apiKey, input.system, input.user)
    );
    return { ok: true, data: input.schema.parse(response) };
  } catch (error) {
    const message = `${input.purpose}: ${error instanceof Error ? error.message : String(error)}`;
    if (!config.aiEnhancements.failOpen) {
      throw new Error(message);
    }
    return { ok: false, error: message };
  }
}

function resolveApiKey(config: AiPwConfig): string | undefined {
  if (config.ai.apiKey) {
    return config.ai.apiKey;
  }

  if (!config.ai.apiKeyEnv) {
    return undefined;
  }

  return process.env[config.ai.apiKeyEnv] ?? config.ai.apiKeyEnv;
}

async function requestRawJson(config: AiPwConfig, apiKey: string, system: string, user: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiEnhancements.timeoutMs);

  try {
    const response = await fetch(`${config.ai.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: config.ai.temperature,
        messages: [
          {
            role: 'system',
            content: `${system}\n只输出 JSON，不输出 Markdown。`
          },
          {
            role: 'user',
            content: JSON.stringify(user, null, 2)
          }
        ]
      })
    });

    const payload = (await response.json()) as ChatCompletionResponse;
    if (!response.ok) {
      throw new Error(payload.error?.message ?? response.statusText);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('empty model response');
    }

    return JSON.parse(extractJson(content));
  } finally {
    clearTimeout(timeout);
  }
}

async function retry<T>(maxRetries: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced?.[1]) {
    return fenced[1];
  }

  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return content.slice(start, end + 1);
  }

  return content;
}
