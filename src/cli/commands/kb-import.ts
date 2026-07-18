import { loadConfig } from '../../config/load-config.js';
import { kbDraftSchema } from '../../kb/draft-schema.js';
import { importDraft, openKb } from '../../kb/repository.js';
import { readJsonFile } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

export async function kbImportCommand(draftPath: string, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const resolvedDraftPath = resolveFromCwd(cwd, draftPath);
  const draft = kbDraftSchema.parse(await readJsonFile<unknown>(resolvedDraftPath));
  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));

  try {
    const result = importDraft(db, draft);
    console.log(`已导入页面：${draft.page.name}`);
    console.log(`页面 ID：${result.pageId}`);
    console.log(`元素：${result.importedElements} 个`);
    console.log(`业务动作：${result.importedActions} 个`);
  } finally {
    db.close();
  }
}
