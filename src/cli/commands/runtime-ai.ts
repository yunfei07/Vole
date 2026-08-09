import { chromium, type Page } from '@playwright/test';
import { loadConfig } from '../../config/load-config.js';
import type { VoleConfig } from '../../config/schema.js';
import { waitForPageReady } from '../../playwright/page-readiness.js';
import {
  createAiRuntime,
  type AiActResult,
  type AiAgentResult
} from '../../runtime-ai/index.js';
import { pathExists } from '../../utils/fs.js';
import { resolveFromCwd } from '../../utils/paths.js';
import { joinUrl } from '../../utils/url.js';
import { getLogger } from '../../logging/context.js';

export type RuntimeAiCommandOptions = {
  url?: string;
  headed?: boolean;
  model?: string;
  timeout?: string;
};

export type AgentCommandOptions = RuntimeAiCommandOptions & {
  maxSteps?: string;
};

export async function actCommand(
  instruction: string,
  options: RuntimeAiCommandOptions,
  cwd = process.cwd()
): Promise<AiActResult> {
  const normalizedInstruction = requireInstruction(instruction);
  const timeoutMs = parsePositiveIntegerOption('--timeout', options.timeout);
  return runWithRuntime(cwd, options, async (page, config) => {
    const runtime = createAiRuntime(page, { cwd, config });
    try {
      const result = await runtime.act({
        instruction: normalizedInstruction,
        model: options.model,
        timeoutMs
      });
      if (!result.success) {
        throw new Error(`ACT_FAILED: ${result.message}`);
      }
      console.log(JSON.stringify(result, null, 2));
      return result;
    } finally {
      await runtime.close();
    }
  });
}

export async function agentCommand(
  instruction: string,
  options: AgentCommandOptions,
  cwd = process.cwd()
): Promise<AiAgentResult> {
  const normalizedInstruction = requireInstruction(instruction);
  const timeoutMs = parsePositiveIntegerOption('--timeout', options.timeout);
  const maxSteps = parsePositiveIntegerOption('--max-steps', options.maxSteps);
  return runWithRuntime(cwd, options, async (page, config) => {
    const runtime = createAiRuntime(page, { cwd, config });
    try {
      const agent = runtime.agent({ model: options.model });
      const result = await agent.execute({
        instruction: normalizedInstruction,
        timeoutMs,
        maxSteps
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    } finally {
      await runtime.close();
    }
  });
}

export function parsePositiveIntegerOption(name: string, value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function resolveRuntimeUrl(baseUrl: string, target?: string): string {
  return target ? joinUrl(baseUrl, target) : baseUrl;
}

async function runWithRuntime<T>(
  cwd: string,
  options: RuntimeAiCommandOptions,
  execute: (page: Page, config: VoleConfig) => Promise<T>
): Promise<T> {
  const logger = getLogger().child({ component: 'browser' });
  const config = await loadConfig(cwd);
  const storageStatePath = resolveFromCwd(cwd, config.auth.storageState);
  logger.info('browser.launching', {
    operation: 'runtime-ai',
    headless: options.headed ? false : config.playwright.headless
  });
  const browser = await chromium.launch({
    headless: options.headed ? false : config.playwright.headless
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: config.playwright.ignoreHTTPSErrors,
    ...((await pathExists(storageStatePath)) ? { storageState: storageStatePath } : {})
  });
  const page = await context.newPage();

  try {
    const targetUrl = resolveRuntimeUrl(config.baseUrl, options.url);
    logger.info('browser.navigation_started', { operation: 'runtime-ai', url: targetUrl });
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.playwright.timeout
    });
    await waitForPageReady(page, config);
    logger.info('browser.page_ready', { operation: 'runtime-ai', url: page.url() });
    return await execute(page, config);
  } finally {
    await browser.close();
    logger.info('browser.closed', { operation: 'runtime-ai' });
  }
}

function requireInstruction(instruction: string): string {
  const normalized = instruction.trim();
  if (!normalized) {
    throw new Error('instruction must not be empty');
  }
  return normalized;
}
