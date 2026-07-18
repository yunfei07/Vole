import type { AiPwConfig } from '../config/schema.js';
import type { ParsedCase } from '../cases/markdown-parser.js';
import { testPlanSchema, type TestPlan } from '../cases/test-plan-schema.js';
import { RuntimeModelClient } from '../runtime-ai/model-client.js';

export async function compileCaseWithAi(
  config: AiPwConfig,
  parsedCase: ParsedCase
): Promise<TestPlan> {
  const client = new RuntimeModelClient(config);
  const result = await client.generateObject({
    purpose: 'AI_PARSE_FAILED',
    system: [
      '你是一个测试用例编译器。',
      '把中文自然语言测试用例转换成 TestPlan。',
      'steps 中每一步必须保留 rawText，id 使用 step_001 递增。',
      'action 只能是 goto/click/fill/select/upload/assertText/assertVisible/businessAction。',
      '进入页面用 goto；搜索订单编号用 businessAction target=搜索订单 inputs.orderNo；点击用 click；断言 X 为 Y 用 assertText。',
      'target 必须使用简洁中文语义名称，例如 订单管理页面、审批按钮、通过按钮、订单状态。'
    ].join('\n'),
    user: {
      case: {
        name: parsedCase.name,
        role: parsedCase.role,
        preconditions: parsedCase.preconditions,
        steps: parsedCase.steps
      }
    },
    schema: testPlanSchema,
    timeoutMs: config.ai.timeoutMs
  });
  return result.value;
}
