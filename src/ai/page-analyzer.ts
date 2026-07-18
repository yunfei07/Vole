import { z } from 'zod';
import type { VoleConfig } from '../config/schema.js';
import type { KbDraft } from '../kb/draft-schema.js';
import { requestAiJson } from './json-client.js';

export const pageAnalysisSchema = z.object({
  pagePurpose: z.string().optional(),
  regions: z.array(z.object({
    name: z.string().min(1),
    type: z.enum(['filter_form', 'form', 'table', 'dialog', 'tabs', 'toolbar', 'card', 'unknown']),
    elementNames: z.array(z.string()),
    rowKeyCandidates: z.array(z.string())
  })),
  semanticPatches: z.array(z.object({
    elementIndex: z.number().int().min(0),
    suggestedName: z.string().min(1),
    confidence: z.number().min(0).max(1),
    reason: z.string().optional()
  })),
  businessActions: z.array(z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    inputSchema: z.record(z.string()).optional(),
    steps: z.array(z.record(z.unknown())).min(1),
    confidence: z.number().min(0).max(1)
  }))
});

export type PageAnalysis = z.infer<typeof pageAnalysisSchema>;

export async function analyzePageWithAi(config: VoleConfig, draft: KbDraft): Promise<PageAnalysis | undefined> {
  if (!config.aiEnhancements.enabled || !config.aiEnhancements.pageAnalysis) {
    return undefined;
  }

  const result = await requestAiJson(config, {
    purpose: 'AI_PAGE_ANALYSIS_FAILED',
    schema: pageAnalysisSchema,
    system: [
      '你是后台管理系统页面分析器。',
      '根据扫描到的元素，识别页面用途、区域、表格行主键、可复用业务动作。',
      '不要编造页面上不存在的元素。semanticPatches 必须引用已有 elementIndex。',
      'businessActions 的步骤只能引用现有元素语义名称或建议语义名称。'
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

export function applyPageAnalysis(draft: KbDraft, analysis: PageAnalysis | undefined): KbDraft {
  if (!analysis) {
    return draft;
  }

  const usedNames = new Set(draft.elements.map((element) => element.semanticName));
  const elements = draft.elements.map((element, index) => {
    const patch = analysis.semanticPatches.find((item) => item.elementIndex === index);
    if (!patch) {
      return element;
    }

    const contextText = appendContext(element.contextText, [
      `aiSuggestedName=${patch.suggestedName}`,
      `aiNameConfidence=${patch.confidence}`,
      patch.reason ? `aiNameReason=${patch.reason}` : undefined
    ]);

    if (patch.confidence < 0.9 || usedNames.has(patch.suggestedName)) {
      return { ...element, contextText };
    }

    usedNames.delete(element.semanticName);
    usedNames.add(patch.suggestedName);
    return {
      ...element,
      semanticName: patch.suggestedName,
      contextText
    };
  });

  return {
    ...draft,
    page: {
      ...draft.page,
      description: appendContext(draft.page.description, [
        analysis.pagePurpose ? `aiPurpose=${analysis.pagePurpose}` : undefined,
        analysis.regions.length > 0 ? `aiRegions=${analysis.regions.map((region) => `${region.name}:${region.type}`).join(',')}` : undefined
      ])
    },
    elements,
    businessActions: mergeBusinessActions(draft.businessActions, analysis.businessActions)
  };
}

function mergeBusinessActions(existing: KbDraft['businessActions'], suggested: PageAnalysis['businessActions']): KbDraft['businessActions'] {
  const names = new Set(existing.map((action) => action.name));
  const additions: Array<KbDraft['businessActions'][number]> = [];
  for (const action of suggested) {
    if (action.confidence < 0.85 || names.has(action.name)) {
      continue;
    }
    names.add(action.name);
    const addition: KbDraft['businessActions'][number] = {
      name: action.name,
      description: action.description,
      inputSchema: action.inputSchema,
      steps: action.steps
    };
    additions.push(addition);
  }

  return [...existing, ...additions];
}

function appendContext(current: string | undefined, parts: Array<string | undefined>): string | undefined {
  const extra = parts.filter(Boolean).join(' | ');
  if (!extra) {
    return current;
  }
  return current ? `${current} | ${extra}` : extra;
}
