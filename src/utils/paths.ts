import path from 'node:path';

export function resolveFromCwd(cwd: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
}
