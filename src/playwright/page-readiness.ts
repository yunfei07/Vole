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

/** DOM settle wait: hold for a 500ms network-quiet window before snapshotting. */
export async function waitForDomNetworkQuiet(page: Page, timeoutMs = 5000): Promise<void> {
  const overallTimeout = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 5000;
  const startedAt = Date.now();
  const readyState = await page.evaluate(() => document.readyState).catch(() => 'loading');
  if (readyState !== 'interactive' && readyState !== 'complete' && overallTimeout > 0) {
    await page.waitForLoadState('domcontentloaded', { timeout: overallTimeout }).catch(() => undefined);
  }
  const remaining = Math.max(0, overallTimeout - (Date.now() - startedAt));
  if (remaining === 0) return;

  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable').catch(() => undefined);
  await session.send('Page.enable').catch(() => undefined);
  await session.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [
      { type: 'worker', exclude: true },
      { type: 'shared_worker', exclude: true }
    ]
  }).catch(() => undefined);

  await new Promise<void>((resolve) => {
    const inflight = new Set<string>();
    const startedRequests = new Map<string, number>();
    const documentRequestByFrame = new Map<string, string>();
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let sweepTimer: ReturnType<typeof setInterval> | undefined;
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;

    const cleanup = (): void => {
      if (done) return;
      done = true;
      session.off('Network.requestWillBeSent', onRequest);
      session.off('Network.loadingFinished', onFinished);
      session.off('Network.loadingFailed', onFinished);
      session.off('Network.requestServedFromCache', onFinished);
      session.off('Network.responseReceived', onResponse);
      session.off('Page.frameStoppedLoading', onFrameStopped);
      if (quietTimer) clearTimeout(quietTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      if (guardTimer) clearTimeout(guardTimer);
      resolve();
    };
    const clearQuiet = (): void => {
      if (!quietTimer) return;
      clearTimeout(quietTimer);
      quietTimer = undefined;
    };
    const maybeQuiet = (): void => {
      if (inflight.size === 0 && !quietTimer) quietTimer = setTimeout(cleanup, 500);
    };
    const finish = (requestId: string): void => {
      if (!inflight.delete(requestId)) return;
      startedRequests.delete(requestId);
      for (const [frameId, id] of documentRequestByFrame) {
        if (id === requestId) documentRequestByFrame.delete(frameId);
      }
      clearQuiet();
      maybeQuiet();
    };
    const onRequest = (event: {
      requestId: string;
      type?: string;
      frameId?: string;
    }): void => {
      if (event.type === 'WebSocket' || event.type === 'EventSource') return;
      inflight.add(event.requestId);
      startedRequests.set(event.requestId, Date.now());
      if (event.type === 'Document' && event.frameId) {
        documentRequestByFrame.set(event.frameId, event.requestId);
      }
      clearQuiet();
    };
    const onFinished = (event: { requestId: string }): void => finish(event.requestId);
    const onResponse = (event: {
      requestId: string;
      response?: { url?: string };
    }): void => {
      if (event.response?.url?.startsWith('data:')) finish(event.requestId);
    };
    const onFrameStopped = (event: { frameId: string }): void => {
      const requestId = documentRequestByFrame.get(event.frameId);
      if (requestId) finish(requestId);
    };

    session.on('Network.requestWillBeSent', onRequest);
    session.on('Network.loadingFinished', onFinished);
    session.on('Network.loadingFailed', onFinished);
    session.on('Network.requestServedFromCache', onFinished);
    session.on('Network.responseReceived', onResponse);
    session.on('Page.frameStoppedLoading', onFrameStopped);

    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [requestId, requestStartedAt] of startedRequests) {
        if (now - requestStartedAt > 2000) finish(requestId);
      }
      maybeQuiet();
    }, 500);
    guardTimer = setTimeout(cleanup, remaining);
    maybeQuiet();
  }).finally(() => session.detach().catch(() => undefined));
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
