import { spawn } from 'node:child_process';
import path from 'node:path';

export async function validateGeneratedTypescript(cwd: string, files: string[]): Promise<void> {
  const tscPath = path.resolve(cwd, 'node_modules/typescript/bin/tsc');
  const args = [
    tscPath,
    '--noEmit',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--strict',
    '--lib',
    'ES2022,DOM',
    '--types',
    'node',
    ...files
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`TYPESCRIPT_VALIDATE_FAILED\n${stdout}${stderr}`.trim()));
    });
  });
}
