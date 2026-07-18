import { z } from 'zod';
import type { AiPwConfig } from '../config/schema.js';
import type { KbDraft } from '../kb/draft-schema.js';
import { requestAiJson } from './json-client.js';

export const locatorRankingSchema = z.object({
  rankings: z.array(z.object({
    elementIndex: z.number().int().min(0),
    preferred: z.enum(['primary', 'fallback']),
    confidence: z.number().min(0).max(1),
    reason: z.string().optional(),
    risk: z.string().optional()
  }))
});

export type LocatorRanking = z.infer<typeof locatorRankingSchema>;

export async function rankLocatorsWithAi(config: AiPwConfig, draft: KbDraft): Promise<LocatorRanking | undefined> {
  if (!config.aiEnhancements.enabled || !config.aiEnhancements.locatorRanking) {
    return undefined;
  }

  const result = await requestAiJson(config, {
    purpose: 'AI_LOCATOR_RANKING_FAILED',
    schema: locatorRankingSchema,
    system: [
      '你是 Playwright locator 稳定性评估器。',
      '只能在 primary 和 fallback 之间选择，不允许编造新 locator。',
      '优先选择具备业务上下文的 locator，例如 row/dialog/container scope。',
      '如果 fallback 不存在，必须选择 primary。'
    ].join('\n'),
    user: {
      page: draft.page,
      elements: draft.elements.map((element, index) => ({
        index,
        semanticName: element.semanticName,
        elementType: element.elementType,
        role: element.role,
        testId: element.testId,
        visibleText: element.visibleText,
        primary: element.locatorPrimary,
        fallback: element.locatorFallback,
        contextText: element.contextText,
        confidence: element.confidence
      }))
    }
  });

  return result.ok ? result.data : undefined;
}

export function applyLocatorRanking(draft: KbDraft, ranking: LocatorRanking | undefined): KbDraft {
  if (!ranking) {
    return draft;
  }

  const elements = draft.elements.map((element, index) => {
    const recommendation = ranking.rankings.find((item) => item.elementIndex === index);
    if (!recommendation) {
      return element;
    }

    const fallback = element.locatorFallback;
    const shouldSwap = recommendation.preferred === 'fallback' && fallback !== undefined && recommendation.confidence >= 0.85;
    return {
      ...element,
      locatorPrimary: shouldSwap ? fallback : element.locatorPrimary,
      locatorFallback: shouldSwap ? element.locatorPrimary : element.locatorFallback,
      contextText: appendContext(element.contextText, [
        `aiLocatorPreferred=${recommendation.preferred}`,
        `aiLocatorConfidence=${recommendation.confidence}`,
        recommendation.reason ? `aiLocatorReason=${recommendation.reason}` : undefined,
        recommendation.risk ? `aiLocatorRisk=${recommendation.risk}` : undefined
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
