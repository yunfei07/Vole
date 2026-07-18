import type { AiPwConfig } from '../config/schema.js';
import type { ParsedCase } from '../cases/markdown-parser.js';
import { testPlanSchema, type TestPlan } from '../cases/test-plan-schema.js';

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export async function compileCaseWithAi(config: AiPwConfig, parsedCase: ParsedCase): Promise<TestPlan> {
  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    throw new Error('AI_PARSE_FAILED: ai.apiKey is empty and ai.apiKeyEnv is not set');
  }

  const response = await retry(config.ai.maxRetries, () => requestPlan(config, apiKey, parsedCase));
  return testPlanSchema.parse(response);
}

async function requestPlan(config: AiPwConfig, apiKey: string, parsedCase: ParsedCase): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.ai.timeoutMs);

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
            content: [
              '你是一个测试用例编译器，只输出 JSON，不输出 Markdown。',
              '把中文自然语言测试用例转换成 TestPlan。',
              'steps 中每一步必须保留 rawText，id 使用 step_001 递增。',
              'action 只能是 goto/click/fill/select/upload/assertText/assertVisible/businessAction。',
              '进入页面用 goto；搜索订单编号用 businessAction target=搜索订单 inputs.orderNo；点击用 click；断言 X 为 Y 用 assertText。',
              'target 必须使用简洁中文语义名称，例如 订单管理页面、审批按钮、通过按钮、订单状态。'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify(
              {
                requiredShape: {
                  name: 'string',
                  role: 'string optional',
                  preconditions: ['string'],
                  steps: [
                    {
                      id: 'step_001',
                      rawText: 'string',
                      action: 'goto | click | fill | select | upload | assertText | assertVisible | businessAction',
                      target: 'string',
                      value: 'string when needed',
                      filePath: 'string when upload',
                      inputs: 'object when businessAction',
                      page: 'string optional',
                      state: 'string optional',
                      confidence: 'number 0-1 optional'
                    }
                  ]
                },
                case: {
                  name: parsedCase.name,
                  role: parsedCase.role,
                  preconditions: parsedCase.preconditions,
                  steps: parsedCase.steps
                }
              },
              null,
              2
            )
          }
        ]
      })
    });

    const payload = (await response.json()) as ChatCompletionResponse & { error?: { message?: string } };
    if (!response.ok) {
      throw new Error(`AI_PARSE_FAILED: ${payload.error?.message ?? response.statusText}`);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('AI_PARSE_FAILED: empty model response');
    }

    return JSON.parse(extractJson(content));
  } finally {
    clearTimeout(timeout);
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
