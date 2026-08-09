import { auditKnowledgeBase } from '../../ai/kb-auditor.js';
import { loadConfig } from '../../config/load-config.js';
import { listElements, openKb } from '../../kb/repository.js';
import { resolveFromCwd } from '../../utils/paths.js';
import { getLogger } from '../../logging/context.js';

export type KbAuditOptions = {
  page?: string;
};

export async function kbAuditCommand(options: KbAuditOptions, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));

  try {
    const elements = listElements(db, options.page);
    const issues = await auditKnowledgeBase(config, elements);
    getLogger().child({ component: 'kb' }).info('kb.audit_completed', {
      elementCount: elements.length,
      issueCount: issues.length
    });

    console.log(`审计元素：${elements.length} 个`);
    console.log(`发现问题：${issues.length} 个`);
    if (issues.length === 0) {
      return;
    }

    console.table(
      issues.map((issue) => ({
        severity: issue.severity,
        type: issue.type,
        elementId: issue.elementId ?? '',
        locator: issue.locator ?? '',
        message: issue.message,
        recommendation: issue.recommendation
      }))
    );
  } finally {
    db.close();
  }
}
