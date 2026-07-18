import { loadConfig } from '../../config/load-config.js';
import { listActions, listElements, listPages, listRunResults, openKb } from '../../kb/repository.js';
import { resolveFromCwd } from '../../utils/paths.js';

export type KbListOptions = {
  page?: string;
};

export async function kbListCommand(target: string, options: KbListOptions, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));

  try {
    if (target === 'pages') {
      console.table(
        listPages(db).map((page) => ({
          id: page.id,
          name: page.name,
          url: page.url,
          title: page.title ?? ''
        }))
      );
      return;
    }

    if (target === 'elements') {
      console.table(
        listElements(db, options.page).map((element) => ({
          id: element.id,
          page: element.page_name,
          name: element.semantic_name,
          type: element.element_type ?? '',
          role: element.role ?? '',
          testId: element.test_id ?? '',
          confidence: element.confidence,
          status: element.status,
          source: element.source ?? '',
          locator: element.locator_primary
        }))
      );
      return;
    }

    if (target === 'actions') {
      console.table(
        listActions(db).map((action) => ({
          id: action.id,
          name: action.name,
          page: action.page_name ?? '',
          description: action.description ?? ''
        }))
      );
      return;
    }

    if (target === 'runs') {
      console.table(
        listRunResults(db).map((run) => ({
          id: run.id,
          spec: run.spec_path,
          status: run.status,
          errorType: run.error_type ?? '',
          trace: run.trace_path ?? '',
          screenshot: run.screenshot_path ?? '',
          startedAt: run.started_at
        }))
      );
      return;
    }

    throw new Error('kb list target must be one of: pages, elements, actions, runs');
  } finally {
    db.close();
  }
}
