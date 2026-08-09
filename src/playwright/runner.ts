import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getLogger, internalLogEnvironment } from '../logging/context.js';
import { hashSensitiveText } from '../logging/logger.js';
import { ensureDir, pathExists } from '../utils/fs.js';

export type PlaywrightRunResult = {
  specPath: string;
  status: 'passed' | 'failed';
  exitCode: number;
  reportPath: string;
  errorType?: string;
  errorMessage?: string;
  tracePath?: string;
  screenshotPath?: string;
  startedAt: string;
  finishedAt: string;
};

type JsonReport = {
  suites?: Array<{
    specs?: Array<{
      title?: string;
      tests?: Array<{
        results?: Array<{
          status?: string;
          error?: {
            message?: string;
          };
          errors?: Array<{ message?: string }>;
          attachments?: Array<{
            name?: string;
            path?: string;
            contentType?: string;
          }>;
        }>;
      }>;
    }>;
  }>;
};

type TestResult = NonNullable<
  NonNullable<NonNullable<NonNullable<JsonReport['suites']>[number]['specs']>[number]['tests']>[number]['results']
>[number];

export async function runPlaywrightSpec(
  cwd: string,
  specPath: string,
  options: { artifactsDir: string }
): Promise<PlaywrightRunResult> {
  const logger = getLogger().child({ component: 'playwright' });
  const startedAt = new Date().toISOString();
  const reportPath = path.resolve(cwd, options.artifactsDir, 'results', `${safeName(specPath)}-${Date.now()}.json`);
  await ensureDir(path.dirname(reportPath));

  logger.info('playwright.run_started', { specPath, reportPath });
  const exitCode = await runCommand(cwd, specPath, reportPath);
  const finishedAt = new Date().toISOString();
  const report = await readReport(reportPath);
  const failedResult = firstFailedResult(report);
  const attachments = failedResult?.attachments ?? [];

  const errorMessage = failedResult?.error?.message ?? failedResult?.errors?.[0]?.message;
  const result: PlaywrightRunResult = {
    specPath,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    reportPath,
    errorType: failedResult ? classifyError(failedResult.error?.message ?? failedResult.errors?.[0]?.message ?? '') : undefined,
    errorMessage,
    tracePath: attachments.find((item) => item.name === 'trace')?.path,
    screenshotPath: attachments.find((item) => item.name === 'screenshot')?.path,
    startedAt,
    finishedAt
  };
  logger.info('playwright.run_completed', {
    status: result.status,
    exitCode,
    reportPath,
    errorType: result.errorType,
    errorMessageHash: errorMessage ? hashSensitiveText(errorMessage) : undefined,
    tracePath: result.tracePath,
    screenshotPath: result.screenshotPath,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt)
  });
  return result;
}

function runCommand(cwd: string, specPath: string, reportPath: string): Promise<number> {
  const logger = getLogger().child({ component: 'playwright' });
  const cliPath = createRequire(import.meta.url).resolve('@playwright/test/cli');
  const args = [cliPath, 'test', specPath, '--reporter=json'];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        ...internalLogEnvironment(getLogger()),
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    logger.info('playwright.process_started', { childPid: child.pid, specPath });

    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      logger.error('playwright.process_failed', {
        message: 'Failed to start Playwright process',
        error
      });
      reject(error);
    });
    child.on('close', (code) => {
      logger.info('playwright.process_exited', { childPid: child.pid, exitCode: code ?? 1 });
      resolve(code ?? 1);
    });
  });
}

async function readReport(reportPath: string): Promise<JsonReport> {
  if (!(await pathExists(reportPath))) {
    return {};
  }

  return JSON.parse(await readFile(reportPath, 'utf8')) as JsonReport;
}

function firstFailedResult(report: JsonReport): TestResult | undefined {
  for (const suite of report.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          if (result.status && result.status !== 'passed') {
            return result;
          }
        }
      }
    }
  }

  return undefined;
}

function classifyError(message: string): string {
  if (/AI_ASSERT_FAILED/i.test(message)) return 'AI_ASSERT_FAILED';
  if (/AI_ACT_FAILED/i.test(message)) return 'AI_ACT_FAILED';
  if (/AI_AGENT_FAILED/i.test(message)) return 'AI_AGENT_FAILED';
  if (/AI_MODEL_|AI_RUNTIME_/i.test(message)) return 'AI_RUNTIME_FAILED';
  if (/toHaveText|expect/i.test(message)) return 'ASSERTION_FAILED';
  if (/locator|strict mode|waiting for .*locator/i.test(message)) return 'LOCATOR_NOT_FOUND';
  if (/Timeout/i.test(message)) return 'TIMEOUT';
  if (/net::|navigation|goto/i.test(message)) return 'NAVIGATION_FAILED';
  return 'UNKNOWN';
}

function safeName(input: string): string {
  return input.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'run';
}
