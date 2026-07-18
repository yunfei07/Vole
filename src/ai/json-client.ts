import type { z } from 'zod';
import type { AiPwConfig } from '../config/schema.js';
import { RuntimeModelClient } from '../runtime-ai/model-client.js';

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
  try {
    const client = new RuntimeModelClient({
      ...config,
      ai: {
        ...config.ai,
        maxRetries: config.aiEnhancements.maxRetries
      }
    });
    const result = await client.generateObject({
      ...input,
      timeoutMs: config.aiEnhancements.timeoutMs
    });
    return { ok: true, data: result.value };
  } catch (error) {
    const message = `${input.purpose}: ${error instanceof Error ? error.message : String(error)}`;
    if (!config.aiEnhancements.failOpen) {
      throw new Error(message);
    }
    return { ok: false, error: message };
  }
}
