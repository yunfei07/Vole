import path from 'node:path';
import { generateDiagnosis, readPlaywrightReport } from '../../diagnostics/report-generator.js';
import { loadConfig } from '../../config/load-config.js';
import { getRunResult, openKb } from '../../kb/repository.js';
import { pathExists } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';

export async function diagnoseCommand(target: string, cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const db = await openKb(resolveFromCwd(cwd, config.knowledgeBase));

  try {
    const run = getRunResult(db, target);
    if (run) {
      console.log(await generateDiagnosis(cwd, { kind: 'run', run }));
      return;
    }
  } finally {
    db.close();
  }

  const reportPath = resolveFromCwd(cwd, target);
  if (!(await pathExists(reportPath))) {
    throw new Error(`TRACE_NOT_FOUND: not a run id or report path: ${target}`);
  }

  const report = await readPlaywrightReport(reportPath);
  console.log(await generateDiagnosis(cwd, { kind: 'report', reportPath: path.relative(cwd, reportPath), report }));
}
