import type { AiPwConfig } from '../config/schema.js';
import type { KbDraft } from '../kb/draft-schema.js';
import { applyComponentClassification, classifyComponentsWithAi } from './component-classifier.js';
import { applyLocatorRanking, rankLocatorsWithAi } from './locator-ranker.js';
import { analyzePageWithAi, applyPageAnalysis } from './page-analyzer.js';

export async function enhanceScanDraftWithAi(config: AiPwConfig, draft: KbDraft): Promise<KbDraft> {
  if (!config.aiEnhancements.enabled) {
    return draft;
  }

  let enhanced = draft;

  if (config.aiEnhancements.componentClassification) {
    enhanced = applyComponentClassification(enhanced, await classifyComponentsWithAi(config, enhanced));
  }

  if (config.aiEnhancements.pageAnalysis) {
    enhanced = applyPageAnalysis(enhanced, await analyzePageWithAi(config, enhanced));
  }

  if (config.aiEnhancements.locatorRanking) {
    enhanced = applyLocatorRanking(enhanced, await rankLocatorsWithAi(config, enhanced));
  }

  return enhanced;
}
