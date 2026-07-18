import { z } from 'zod';
import type { VoleConfig } from '../config/schema.js';
import type { KbDraft } from '../kb/draft-schema.js';
import { requestAiJson } from './json-client.js';

export const componentClassificationSchema = z.object({
  components: z.array(z.object({
    elementIndex: z.number().int().min(0),
    componentType: z.enum([
      'native-input',
      'native-select',
      'button',
      'table',
      'tabs',
      'modal',
      'drawer',
      'dropdown',
      'custom-select',
      'date-picker',
      'tree-select',
      'cascader',
      'upload',
      'rich-text-editor',
      'unknown'
    ]),
    confidence: z.number().min(0).max(1),
    operationHint: z.string().optional()
  }))
});

export type ComponentClassification = z.infer<typeof componentClassificationSchema>;

export async function classifyComponentsWithAi(config: VoleConfig, draft: KbDraft): Promise<ComponentClassification | undefined> {
  if (!config.aiEnhancements.enabled || !config.aiEnhancements.componentClassification) {
    return undefined;
  }

  const result = await requestAiJson(config, {
    purpose: 'AI_COMPONENT_CLASSIFICATION_FAILED',
    schema: componentClassificationSchema,
    system: [
      '你是后台管理系统组件分类器。',
      '根据元素类型、role、可见文本、testId、locator 和上下文识别组件类型。',
      '重点识别非原生 select、日期选择器、抽屉、弹窗、下拉菜单、上传、富文本等复杂组件。',
      '不要输出不存在的 elementIndex。'
    ].join('\n'),
    user: {
      page: draft.page,
      elements: draft.elements.map((element, index) => ({
        index,
        semanticName: element.semanticName,
        elementType: element.elementType,
        role: element.role,
        visibleText: element.visibleText,
        label: element.label,
        placeholder: element.placeholder,
        testId: element.testId,
        locator: element.locatorPrimary,
        contextText: element.contextText
      }))
    }
  });

  return result.ok ? result.data : undefined;
}

export function applyComponentClassification(draft: KbDraft, classification: ComponentClassification | undefined): KbDraft {
  if (!classification) {
    return draft;
  }

  const elements = draft.elements.map((element, index) => {
    const component = classification.components.find((item) => item.elementIndex === index);
    if (!component || component.confidence < 0.75) {
      return element;
    }

    return {
      ...element,
      contextText: appendContext(element.contextText, [
        `componentType=${component.componentType}`,
        `componentConfidence=${component.confidence}`,
        component.operationHint ? `componentHint=${component.operationHint}` : undefined
      ])
    };
  });

  return { ...draft, elements };
}

function appendContext(current: string | undefined, parts: Array<string | undefined>): string | undefined {
  const extra = parts.filter(Boolean).join(' | ');
  if (!extra) {
    return current;
  }
  return current ? `${current} | ${extra}` : extra;
}
