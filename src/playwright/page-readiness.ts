import type { Page } from '@playwright/test';
import type { VoleConfig } from '../config/schema.js';

export async function waitForPageReady(
  page: Page,
  config: VoleConfig,
  overrideWaitMs?: number
): Promise<void> {
  const ready = config.pageReady;
  const waitMs = overrideWaitMs ?? ready.waitAfterLoadMs;

  if (ready.waitForNetworkIdle) {
    await page.waitForLoadState('networkidle', { timeout: ready.networkIdleTimeoutMs }).catch(() => undefined);
  }

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }

  await waitForLoadingSelectors(page, ready.loadingSelectors, ready.timeoutMs);
  await waitForHintSelectors(page, ready.waitForSelectors, ready.timeoutMs);

  if (ready.domStableMs > 0) {
    await waitForDomStable(page, ready.domStableMs, ready.timeoutMs).catch(() => undefined);
  }
}

async function waitForLoadingSelectors(page: Page, selectors: string[], timeoutMs: number): Promise<void> {
  for (const selector of selectors) {
    await page.locator(selector).first().waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => undefined);
  }
}

async function waitForHintSelectors(page: Page, selectors: string[], timeoutMs: number): Promise<void> {
  for (const selector of selectors) {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs }).catch(() => undefined);
  }
}

async function waitForDomStable(page: Page, stableMs: number, timeoutMs: number): Promise<void> {
  await page.evaluate(
    ({ stableMs: stableWindowMs, timeoutMs: maxWaitMs }) =>
      new Promise<void>((resolve) => {
        let settled = false;
        let stableTimer: ReturnType<typeof setTimeout> | undefined;
        let maxTimer: ReturnType<typeof setTimeout> | undefined;

        const finish = () => {
          if (settled) return;
          settled = true;
          if (stableTimer) clearTimeout(stableTimer);
          if (maxTimer) clearTimeout(maxTimer);
          observer.disconnect();
          resolve();
        };

        const scheduleStable = () => {
          if (stableTimer) clearTimeout(stableTimer);
          stableTimer = setTimeout(finish, stableWindowMs);
        };

        const observer = new MutationObserver(scheduleStable);
        observer.observe(document.documentElement, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true
        });

        maxTimer = setTimeout(finish, maxWaitMs);
        scheduleStable();
      }),
    { stableMs, timeoutMs }
  );
}
