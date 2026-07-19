import type { ActionRow, ElementRow, PageRow } from '../kb/repository.js';
import type { TestPlan, TestStep } from '../cases/test-plan-schema.js';
import type { ResolveCandidate, ResolveResult, ResolvedPlan } from './types.js';

export type KnowledgeBaseSnapshot = {
  pages: PageRow[];
  elements: ElementRow[];
  actions: ActionRow[];
};

export type ResolvePlanOptions = {
  aiFallback?: boolean;
};

export function resolvePlan(plan: TestPlan, kb: KnowledgeBaseSnapshot, options: ResolvePlanOptions = {}): ResolvedPlan {
  let currentPageName: string | undefined;
  const steps = plan.steps.map((step) => {
    const resolution = resolveStep(step, kb, currentPageName, options.aiFallback === true);
    if (step.action === 'goto' && resolution.status === 'resolved') {
      currentPageName = resolution.matched?.semanticName;
    }

    return {
      step,
      resolution
    };
  });

  const resolved = steps.filter((item) => item.resolution.status === 'resolved').length;
  const aiFallback = steps.filter((item) => item.resolution.status === 'ai_fallback').length;
  const ambiguous = steps.filter((item) => item.resolution.status === 'ambiguous').length;
  const unresolved = steps.filter((item) => item.resolution.status === 'unresolved').length;

  return {
    name: plan.name,
    role: plan.role,
    preconditions: plan.preconditions,
    status: unresolved === 0 && ambiguous === 0 ? 'resolved' : resolved + aiFallback > 0 ? 'partial' : 'unresolved',
    steps,
    summary: {
      total: steps.length,
      resolved,
      aiFallback,
      ambiguous,
      unresolved
    },
    sourcePlan: plan
  };
}

function resolveStep(step: TestStep, kb: KnowledgeBaseSnapshot, currentPageName: string | undefined, aiFallback: boolean): ResolveResult {
  if (step.action === 'goto') {
    return resolveFromCandidates(step, pageCandidates(step.target, kb.pages));
  }

  if (step.action === 'businessAction') {
    return resolveFromCandidates(step, actionCandidates(step.target, kb.actions, currentPageName), aiFallback ? 'ai-agent' : undefined);
  }

  const fallback = step.action === 'assertText' || step.action === 'assertVisible'
    ? 'ai-assert'
    : 'ai-act';
  return resolveFromCandidates(step, elementCandidates(step, kb.elements, currentPageName), aiFallback ? fallback : undefined);
}

function resolveFromCandidates(
  step: TestStep,
  candidates: ResolveCandidate[],
  fallback?: 'ai-act' | 'ai-agent' | 'ai-assert'
): ResolveResult {
  const sorted = uniqueCandidates(candidates)
    .sort((a, b) => b.confidence - a.confidence)
    .filter((candidate) => candidate.confidence >= 0.5);

  if (sorted.length === 0) {
    if (fallback) {
      return {
        status: 'ai_fallback',
        execution: fallback,
        stepId: step.id,
        target: step.target ?? '',
        reason: 'No static knowledge-base candidate matched; using AI runtime'
      };
    }

    return {
      status: 'unresolved',
      execution: 'static',
      stepId: step.id,
      target: step.target ?? '',
      reason: 'No candidate matched the target'
    };
  }

  if (sorted.length > 1 && sorted[0] && sorted[1] && sorted[0].confidence - sorted[1].confidence < 0.12) {
    if (fallback) {
      return {
        status: 'ai_fallback',
        execution: fallback,
        stepId: step.id,
        target: step.target ?? '',
        candidates: sorted.slice(0, 5),
        reason: 'Static knowledge-base candidates are ambiguous; using AI runtime'
      };
    }

    return {
      status: 'ambiguous',
      execution: 'static',
      stepId: step.id,
      target: step.target ?? '',
      candidates: sorted.slice(0, 5),
      reason: 'Top candidates are too close'
    };
  }

  return {
    status: 'resolved',
    execution: 'static',
    stepId: step.id,
    target: step.target ?? '',
    matched: sorted[0]
  };
}

function uniqueCandidates(candidates: ResolveCandidate[]): ResolveCandidate[] {
  const byKey = new Map<string, ResolveCandidate>();

  for (const candidate of candidates) {
    const key = candidate.locator ? `${candidate.type}:${candidate.locator}` : `${candidate.type}:${candidate.id}`;
    const existing = byKey.get(key);
    if (!existing || compareCandidate(candidate, existing) > 0) {
      byKey.set(key, candidate);
    }
  }

  return Array.from(byKey.values());
}

function compareCandidate(a: ResolveCandidate, b: ResolveCandidate): number {
  if (a.confidence !== b.confidence) {
    return a.confidence - b.confidence;
  }

  const aIsStaticElement = a.id.startsWith('el_') ? 1 : 0;
  const bIsStaticElement = b.id.startsWith('el_') ? 1 : 0;
  return aIsStaticElement - bIsStaticElement;
}

function pageCandidates(target: string, pages: PageRow[]): ResolveCandidate[] {
  return pages
    .map((page) => {
      const confidence = scoreTarget(target, [page.name, page.title ?? undefined, page.url]);
      return {
        id: page.id,
        type: 'page' as const,
        semanticName: page.name,
        pageName: page.name,
        confidence,
        evidence: `page name=${page.name}, url=${page.url}`
      };
    })
    .filter((candidate) => candidate.confidence > 0);
}

function actionCandidates(target: string, actions: ActionRow[], currentPageName?: string): ResolveCandidate[] {
  const scoped = scopeByPage(actions, currentPageName);
  return scoped
    .map((action) => {
      const confidence = scoreTarget(target, [action.name, action.description ?? undefined]);
      return {
        id: action.id,
        type: 'business_action' as const,
        semanticName: action.name,
        pageName: action.page_name ?? undefined,
        confidence,
        evidence: `business action name=${action.name}`
      };
    })
    .filter((candidate) => candidate.confidence > 0);
}

function elementCandidates(step: TestStep, elements: ElementRow[], currentPageName?: string): ResolveCandidate[] {
  const target = step.target ?? '';
  const scoped = scopeByPage(elements, currentPageName);
  return scoped
    .filter((element) => isElementCompatible(step, element))
    .map((element) => {
      const confidence = Math.max(
        scoreTarget(target, [element.semantic_name]),
        scoreTarget(target, [element.visible_text ?? undefined]),
        scoreTarget(target, [element.label ?? undefined]),
        scoreTarget(target, [element.test_id ?? undefined]),
        scoreTarget(target, [element.placeholder ?? undefined]) * 0.6
      );

      return {
        id: element.id,
        type: 'element' as const,
        semanticName: element.semantic_name,
        pageName: element.page_name,
        locator: element.locator_primary,
        confidence: Math.min(1, confidence * Math.max(0.65, element.confidence)),
        evidence: [
          `element name=${element.semantic_name}`,
          element.test_id ? `testId=${element.test_id}` : undefined,
          element.visible_text ? `text=${element.visible_text}` : undefined
        ]
          .filter(Boolean)
          .join(', ')
      };
    })
    .filter((candidate) => candidate.confidence > 0);
}

function isElementCompatible(step: TestStep, element: ElementRow): boolean {
  const target = step.target ?? '';
  const type = element.element_type ?? '';
  const role = element.role ?? '';

  if (target.includes('确认') && !elementText(element).match(/确认|confirm/iu)) {
    return false;
  }

  if (target.includes('取消') && !elementText(element).match(/取消|cancel/iu)) {
    return false;
  }

  if (target.includes('邮箱') && !elementText(element).match(/邮箱|邮件|email/iu)) {
    return false;
  }

  if (target.includes('姓名') && !elementText(element).match(/姓名|名称|name/iu)) {
    return false;
  }

  if (target.includes('错误')) {
    return /(错误|error)/iu.test([element.test_id, element.visible_text, element.label].filter(Boolean).join(' '));
  }

  if (target.includes('按钮')) {
    return type === 'button' || role === 'button';
  }

  if (target.includes('标签')) {
    const targetCore = target.replace(/标签$/u, '');
    const visibleOrLabel = [element.visible_text, element.label].filter(Boolean).join(' ');
    return (
      type === 'tab' ||
      role === 'tab' ||
      /(?:^|[-_])(tab|tabs)(?:$|[-_])/iu.test(element.test_id ?? '') ||
      (targetCore.length > 0 && normalize(visibleOrLabel).includes(normalize(targetCore)))
    );
  }

  if (target.includes('开关') || target.includes('复选')) {
    return type === 'checkbox' || role === 'checkbox';
  }

  if (step.action === 'assertText' && target.includes('状态') && !/(下拉|筛选|过滤|查询|搜索)/u.test(target)) {
    return type !== 'combobox' && role !== 'combobox' && !isSearchOrFilterElement(element);
  }

  if (target.includes('下拉') || step.action === 'select') {
    if (isSearchOrFilterElement(element) && !/(筛选|过滤|查询|搜索)/u.test(target)) {
      return false;
    }

    return type === 'combobox' || role === 'combobox';
  }

  if (target.includes('输入') || step.action === 'fill') {
    if (isSearchOrFilterElement(element) && !/(筛选|过滤|查询|搜索|关键词)/u.test(target)) {
      return false;
    }

    return type === 'textbox' || role === 'textbox';
  }

  return true;
}

function isSearchOrFilterElement(element: ElementRow): boolean {
  return [element.semantic_name, element.test_id ?? '', element.placeholder ?? ''].some((value) => /(搜索|查询|筛选|过滤|keyword|filter|search)/iu.test(value));
}

function elementText(element: ElementRow): string {
  return [element.semantic_name, element.visible_text, element.label, element.test_id].filter(Boolean).join(' ');
}

function scopeByPage<T extends { page_name?: string | null }>(items: T[], currentPageName?: string): T[] {
  if (!currentPageName) {
    return items;
  }

  const scoped = items.filter((item) => item.page_name === currentPageName || item.page_name == null);
  return scoped.length > 0 ? scoped : items;
}

function scoreTarget(target: string, values: Array<string | undefined>): number {
  const normalizedTarget = normalize(target);
  let best = 0;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const normalizedValue = normalize(value);
    if (!normalizedValue) {
      continue;
    }

    if (normalizedValue === normalizedTarget) {
      best = Math.max(best, 1);
      continue;
    }

    if (normalizedValue.includes(normalizedTarget) || normalizedTarget.includes(normalizedValue)) {
      best = Math.max(best, 0.86);
      continue;
    }

    const tokenScore = overlapScore(tokenize(normalizedTarget), tokenize(normalizedValue));
    if (tokenScore > 0) {
      best = Math.max(best, tokenScore);
    }
  }

  return best;
}

function normalize(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[「」"'`\s_-]+/g, '')
    .replace(/元素$/g, '')
    .replace(/控件$/g, '');
}

function tokenize(input: string): string[] {
  const normalized = normalize(input);
  const chunks = normalized.match(/[a-z0-9]+|[\u4e00-\u9fa5]{1,2}/gu);
  return chunks ?? [];
}

function overlapScore(targetTokens: string[], valueTokens: string[]): number {
  if (targetTokens.length === 0 || valueTokens.length === 0) {
    return 0;
  }

  const valueSet = new Set(valueTokens);
  const hits = targetTokens.filter((token) => valueSet.has(token)).length;
  const meaningfulHits = targetTokens.filter((token) => valueSet.has(token) && !genericTokens.has(token)).length;
  const meaningfulTargetTokens = targetTokens.filter((token) => !genericTokens.has(token)).length;
  if (hits === 0 || (meaningfulTargetTokens > 0 && meaningfulHits === 0)) {
    return 0;
  }

  return Math.min(0.78, 0.45 + hits / Math.max(targetTokens.length, valueTokens.length));
}

const genericTokens = new Set(['按钮', '输入', '下拉', '元素', '控件', '链接', '框', '复选']);
