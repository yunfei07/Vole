import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, pathExists } from '../utils/fs.js';

export async function writeGeneratedFile(filePath: string, content: string, overwrite = false): Promise<void> {
  if (!overwrite && (await pathExists(filePath))) {
    throw new Error(`CODEGEN_FAILED: file already exists: ${filePath}. Use --overwrite to replace it.`);
  }

  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, content, 'utf8');
}
