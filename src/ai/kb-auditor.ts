import { z } from 'zod';
import type { AiPwConfig } from '../config/schema.js';
import type { ElementRow } from '../kb/repository.js';
import { requestAiJson } from './json-client.js';

export type KbAuditIssue = {
  severity: 'low' | 'medium' | 'high';
  type: 'semantic_type_mismatch' | 'duplicate_locator' | 'low_confidence' | 'ai_semantic_risk';
  elementId?: string;
  locator?: string;
  message: string;
  recommendation: string;
};

const aiKbAuditSchema = z.object({
  issues: z.array(z.object({
    severity: z.enum(['low', 'medium', 'high']),
    elementId: z.string().optional(),
    type: z.literal('ai_semantic_risk'),
    message: z.string().min(1),
    recommendation: z.string().min(1)
  }))
});

export async function auditKnowledgeBase(config: AiPwConfig, elements: ElementRow[]): Promise<KbAuditIssue[]> {
  const heuristicIssues = heuristicAudit(elements);
  if (!config.aiEnhancements.enabled || !config.aiEnhancements.kbAudit) {
    return heuristicIssues;
  }

  const aiResult = await requestAiJson(config, {
    purpose: 'AI_KB_AUDIT_FAILED',
    schema: aiKbAuditSchema,
    system: [
      '你是自动化测试知识库审计器。',
      '检查元素语义名称、元素类型、role、testId、locator 是否一致。',
      '只报告高价值风险，不要重复报告同类低风险问题。',
      '不要编造 elementId。'
    ].join('\n'),
    user: {
      elements: elements.map((element) => ({
        id: element.id,
        page: element.page_name,
        name: element.semantic_name,
        type: element.element_type,
        role: element.role,
        text: element.visible_text,
        label: element.label,
        testId: element.test_id,
        locator: element.locator_primary,
        confidence: element.confidence,
        source: element.source
      }))
    }
  });

  if (!aiResult.ok) {
    return heuristicIssues;
  }

  return [
    ...heuristicIssues,
    ...aiResult.data.issues.map((issue) => ({
      severity: issue.severity,
      type: issue.type,
      elementId: issue.elementId,
      message: issue.message,
      recommendation: issue.recommendation
    }))
  ];
}

function heuristicAudit(elements: ElementRow[]): KbAuditIssue[] {
  return [
    ...semanticTypeIssues(elements),
    ...duplicateLocatorIssues(elements),
    ...lowConfidenceIssues(elements)
  ];
}

function semanticTypeIssues(elements: ElementRow[]): KbAuditIssue[] {
  return elements
    .filter((element) => {
      const text = elementText(element);
      if (/标签/u.test(text)) return element.element_type !== 'tab' && element.role !== 'tab';
      if (/按钮/u.test(text)) return element.element_type !== 'button' && element.role !== 'button';
      if (/(输入框|输入)/u.test(text)) return element.element_type !== 'textbox' && element.role !== 'textbox';
      if (/(下拉框|下拉)/u.test(text)) return element.element_type !== 'combobox' && element.role !== 'combobox';
      if (/(开关|复选)/u.test(text)) return !['checkbox', 'switch'].includes(element.element_type ?? '') && !['checkbox', 'switch'].includes(element.role ?? '');
      return false;
    })
    .map((element) => ({
      severity: 'high' as const,
      type: 'semantic_type_mismatch' as const,
      elementId: element.id,
      locator: element.locator_primary,
      message: `元素语义与类型不一致：${element.semantic_name} -> ${element.element_type ?? ''}/${element.role ?? ''}`,
      recommendation: '检查静态知识库定义；必要时重新执行 kb scan/import。'
    }));
}

function duplicateLocatorIssues(elements: ElementRow[]): KbAuditIssue[] {
  const byLocator = new Map<string, ElementRow[]>();
  for (const element of elements) {
    const group = byLocator.get(element.locator_primary) ?? [];
    group.push(element);
    byLocator.set(element.locator_primary, group);
  }

  const issues: KbAuditIssue[] = [];
  for (const [locator, group] of byLocator.entries()) {
    const names = new Set(group.map((element) => element.semantic_name));
    if (group.length > 1 && names.size > 1) {
      issues.push({
        severity: 'medium',
        type: 'duplicate_locator',
        locator,
        message: `同一 locator 对应多个语义元素：${Array.from(names).join(', ')}`,
        recommendation: '检查静态元素是否重复或语义命名错误，并通过 kb scan/import 修正。'
      });
    }
  }
  return issues;
}

function lowConfidenceIssues(elements: ElementRow[]): KbAuditIssue[] {
  return elements
    .filter((element) => element.confidence < 0.75)
    .map((element) => ({
      severity: 'low' as const,
      type: 'low_confidence' as const,
      elementId: element.id,
      locator: element.locator_primary,
      message: `低置信度元素：${element.semantic_name} (${element.confidence})`,
      recommendation: '人工复核 locator，或重新扫描页面以生成更稳定候选。'
    }));
}

function elementText(element: ElementRow): string {
  return [element.semantic_name, element.visible_text, element.label, element.test_id].filter(Boolean).join(' ');
}
