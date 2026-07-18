import type { ParsedCase } from './markdown-parser.js';
import type { TestPlan, TestStep } from './test-plan-schema.js';
import { testPlanSchema } from './test-plan-schema.js';

export function compileCaseWithRules(parsedCase: ParsedCase): TestPlan {
  const steps = parsedCase.steps.map((rawText, index) => compileStep(rawText, index));
  return testPlanSchema.parse({
    name: parsedCase.name,
    role: parsedCase.role,
    preconditions: parsedCase.preconditions,
    steps
  });
}

function compileStep(rawText: string, index: number): TestStep {
  const id = `step_${String(index + 1).padStart(3, '0')}`;

  const gotoMatch = rawText.match(/^进入(.+页面)$/);
  if (gotoMatch?.[1]) {
    return {
      id,
      rawText,
      action: 'goto',
      target: gotoMatch[1],
      page: gotoMatch[1],
      confidence: 0.9
    };
  }

  const searchOrderMatch = rawText.match(/^搜索订单编号\s*(.+)$/);
  if (searchOrderMatch?.[1]) {
    return {
      id,
      rawText,
      action: 'businessAction',
      target: '搜索订单',
      inputs: {
        orderNo: searchOrderMatch[1].trim()
      },
      confidence: 0.9
    };
  }

  const clickMatch = rawText.match(/^点击(.+)$/);
  if (clickMatch?.[1]) {
    return {
      id,
      rawText,
      action: 'click',
      target: normalizeTarget(clickMatch[1]),
      confidence: 0.75
    };
  }

  const selectMatch = rawText.match(/^选择(.+)为(.+)$/);
  if (selectMatch?.[1] && selectMatch[2]) {
    return {
      id,
      rawText,
      action: 'select',
      target: normalizeTarget(selectMatch[1]),
      value: selectMatch[2].trim(),
      confidence: 0.75
    };
  }

  const fillMatch = rawText.match(/^在(.+)输入(.+)$/);
  if (fillMatch?.[1] && fillMatch[2]) {
    return {
      id,
      rawText,
      action: 'fill',
      target: normalizeTarget(fillMatch[1]),
      value: fillMatch[2].trim(),
      confidence: 0.7
    };
  }

  const assertTextMatch = rawText.match(/^断言(.+)为(.+)$/);
  if (assertTextMatch?.[1] && assertTextMatch[2]) {
    return {
      id,
      rawText,
      action: 'assertText',
      target: normalizeTarget(assertTextMatch[1]),
      value: assertTextMatch[2].trim(),
      confidence: 0.8
    };
  }

  const assertVisibleMatch = rawText.match(/^断言(.+)可见$/);
  if (assertVisibleMatch?.[1]) {
    return {
      id,
      rawText,
      action: 'assertVisible',
      target: normalizeTarget(assertVisibleMatch[1]),
      confidence: 0.75
    };
  }

  return {
    id,
    rawText,
    action: 'businessAction',
    target: rawText,
    confidence: 0.3
  };
}

function normalizeTarget(target: string): string {
  return target.trim().replace(/^「|」$/g, '');
}
