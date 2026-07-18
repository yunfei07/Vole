import path from 'node:path';
import { loadConfig } from '../../config/load-config.js';
import { importDraft, openKb } from '../../kb/repository.js';
import { defaultDraftPath, scanPage } from '../../playwright/page-scanner.js';
import { writeJsonFile } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

export type KbScanOptions = {
  name?: string;
  url?: string;
  out?: string;
  headed?: boolean;
  wait?: string;
  all?: boolean;
  import?: boolean;
};

export async function kbScanCommand(options: KbScanOptions, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const waitMs = options.wait ? Number.parseInt(options.wait, 10) : config.pageReady.waitAfterLoadMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) {
    throw new Error('--wait must be a non-negative integer');
  }

  const pages = options.all ? config.scanPages : scanTargetFromOptions(options);
  if (pages.length === 0) {
    throw new Error('SCAN_FAILED: no pages configured; set scanPages in .vole/vole.config.json or pass --name and --url');
  }

  if (!options.all && options.out && pages.length > 1) {
    throw new Error('SCAN_FAILED: --out is only supported for single-page scan');
  }

  const db = options.import ? await openKb(resolveFromCwd(cwd, config.knowledgeBase)) : undefined;
  try {
    for (const page of pages) {
      await scanOnePage(cwd, config, {
        name: page.name,
        url: page.url,
        out: options.out,
        headed: options.headed,
        waitMs,
        importToKb: options.import === true,
        db
      });
    }
  } finally {
    db?.close();
  }
}

function scanTargetFromOptions(options: KbScanOptions): Array<{ name: string; url: string }> {
  if (!options.name || !options.url) {
    throw new Error('SCAN_FAILED: pass --all or both --name and --url');
  }

  return [{ name: options.name, url: options.url }];
}

async function scanOnePage(
  cwd: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  options: {
    name: string;
    url: string;
    out?: string;
    headed?: boolean;
    waitMs: number;
    importToKb: boolean;
    db?: Awaited<ReturnType<typeof openKb>>;
  }
): Promise<void> {
  const draft = await scanPage(cwd, config, {
    name: options.name,
    url: options.url,
    headed: options.headed,
    waitMs: options.waitMs
  });

  const outPath = options.out ? resolveFromCwd(cwd, options.out) : defaultDraftPath(cwd, options.name);
  await writeJsonFile(outPath, draft);
  const imported = options.importToKb && options.db ? importDraft(options.db, draft) : undefined;

  const approvedCount = draft.elements.filter((element) => element.status === 'approved').length;
  console.log(`页面：${draft.page.name}`);
  console.log(`URL：${draft.page.url}`);
  console.log(`发现元素：${draft.elements.length} 个`);
  console.log(`高置信度元素：${approvedCount} 个`);
  console.log(`业务动作：${draft.businessActions.length} 个`);
  console.log(`草稿文件：${path.relative(cwd, outPath)}`);
  if (imported) {
    console.log(`已导入知识库：${imported.importedElements} 个元素，${imported.importedActions} 个业务动作`);
  }
}
