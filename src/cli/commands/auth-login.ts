import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import path from "node:path";
import type { VoleConfig } from "../../config/schema.js";
import { loadConfig } from "../../config/load-config.js";
import { ensureDir } from "../../utils/fs.js";
import { resolveFromCwd } from "../../utils/paths.js";
import { joinUrl } from "../../utils/url.js";

type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const POLL_INTERVAL_MS = 100;
const POST_SUBMIT_SETTLE_TIMEOUT_MS = 5000;
const STORAGE_STATE_OPTIONS = { indexedDB: true } as const;

export async function authLoginCommand(cwd = process.cwd()): Promise<void> {
  const config = await loadConfig(cwd);
  const browser = await chromium.launch({
    headless: config.playwright.headless,
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: config.playwright.ignoreHTTPSErrors,
  });
  const page = await context.newPage();
  const loginUrl = joinUrl(config.baseUrl, config.auth.loginUrl);
  const storageStatePath = resolveFromCwd(cwd, config.auth.storageState);

  try {
    await page.goto(loginUrl, {
      waitUntil: "networkidle",
      timeout: config.playwright.timeout,
    });
    const beforeLoginState = await context.storageState(STORAGE_STATE_OPTIONS);

    await page.locator(config.auth.usernameSelector).fill(config.auth.username);
    await page.locator(config.auth.passwordSelector).fill(config.auth.password);
    await submitLogin(
      page,
      config.auth.submitSelector,
      config.playwright.timeout,
    );
    await waitForReusableStorageState(
      context,
      beforeLoginState,
      config.playwright.timeout,
    );
    await assertLoginFormIsGone(page, config);

    await ensureDir(path.dirname(storageStatePath));
    await context.storageState({
      ...STORAGE_STATE_OPTIONS,
      path: storageStatePath,
    });
    await verifySavedAuthState(browser, config, storageStatePath, page.url());
    console.log(`Saved auth state: ${storageStatePath}`);
  } finally {
    await browser.close();
  }
}

async function submitLogin(
  page: Page,
  submitSelector: string,
  timeout: number,
): Promise<void> {
  const previousUrl = page.url();
  await page.locator(submitSelector).click();

  const settleTimeout = Math.min(timeout, POST_SUBMIT_SETTLE_TIMEOUT_MS);
  await Promise.race([
    page
      .waitForURL((url) => url.toString() !== previousUrl, {
        timeout: settleTimeout,
      })
      .catch(() => undefined),
    page
      .waitForLoadState("networkidle", { timeout: settleTimeout })
      .catch(() => undefined),
    delay(settleTimeout),
  ]);
}

async function waitForReusableStorageState(
  context: BrowserContext,
  beforeState: StorageState,
  timeout: number,
): Promise<StorageState> {
  const beforeFingerprint = storageStateFingerprint(beforeState);
  const deadline = Date.now() + timeout;
  let lastState = await context.storageState(STORAGE_STATE_OPTIONS);

  while (Date.now() <= deadline) {
    if (
      storageStateFingerprint(lastState) !== beforeFingerprint &&
      hasReusableStorageState(lastState)
    ) {
      return lastState;
    }

    await delay(POLL_INTERVAL_MS);
    lastState = await context.storageState(STORAGE_STATE_OPTIONS);
  }

  throw new Error(
    "AUTH_LOGIN_FAILED: login did not produce reusable storage state. Check credentials, selectors, and whether the app stores auth in cookies, localStorage, or IndexedDB.",
  );
}

async function verifySavedAuthState(
  browser: Browser,
  config: VoleConfig,
  storageStatePath: string,
  authenticatedUrl: string,
): Promise<void> {
  const loginUrl = joinUrl(config.baseUrl, config.auth.loginUrl);
  if (isSamePageUrl(authenticatedUrl, loginUrl)) {
    return;
  }

  const context = await browser.newContext({
    ignoreHTTPSErrors: config.playwright.ignoreHTTPSErrors,
    storageState: storageStatePath,
  });
  const page = await context.newPage();

  try {
    await page.goto(authenticatedUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.playwright.timeout,
    });
    await page
      .waitForLoadState("networkidle", {
        timeout: Math.min(
          config.playwright.timeout,
          POST_SUBMIT_SETTLE_TIMEOUT_MS,
        ),
      })
      .catch(() => undefined);

    if (isSamePageUrl(page.url(), loginUrl)) {
      throw new Error(
        `AUTH_LOGIN_FAILED: saved storage state was not accepted. Reopened ${authenticatedUrl} but got redirected to ${loginUrl}.`,
      );
    }
  } finally {
    await context.close();
  }
}

async function assertLoginFormIsGone(
  page: Page,
  config: VoleConfig,
): Promise<void> {
  const loginUrl = joinUrl(config.baseUrl, config.auth.loginUrl);
  if (!isSamePageUrl(page.url(), loginUrl)) {
    return;
  }

  const [usernameVisible, passwordVisible, submitVisible] = await Promise.all([
    page
      .locator(config.auth.usernameSelector)
      .isVisible()
      .catch(() => false),
    page
      .locator(config.auth.passwordSelector)
      .isVisible()
      .catch(() => false),
    page
      .locator(config.auth.submitSelector)
      .isVisible()
      .catch(() => false),
  ]);

  if (usernameVisible || passwordVisible || submitVisible) {
    throw new Error(
      "AUTH_LOGIN_FAILED: login form is still visible after submit. Check credentials and selectors.",
    );
  }
}

export function hasReusableStorageState(state: StorageState): boolean {
  return (
    state.cookies.length > 0 ||
    state.origins.some(
      (origin) =>
        origin.localStorage.length > 0 || hasIndexedDbSnapshot(origin),
    )
  );
}

function storageStateFingerprint(state: StorageState): string {
  return JSON.stringify(state);
}

function hasIndexedDbSnapshot(
  origin: StorageState["origins"][number],
): boolean {
  const indexedDB = (origin as { indexedDB?: unknown[] }).indexedDB;
  return Array.isArray(indexedDB) && indexedDB.length > 0;
}

function isSamePageUrl(left: string, right: string): boolean {
  const leftUrl = new URL(left);
  const rightUrl = new URL(right);
  return (
    leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
