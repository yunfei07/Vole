import { chromium, type Page } from "@playwright/test";
import path from "node:path";
import { enhanceScanDraftWithAi } from "../ai/scan-enhancer.js";
import type { AiPwConfig } from "../config/schema.js";
import type { KbDraft, KbDraftElement } from "../kb/draft-schema.js";
import { pathExists } from "../utils/fs.js";
import { slugify } from "../utils/id.js";
import { resolveFromCwd } from "../utils/paths.js";
import { joinUrl } from "../utils/url.js";
import { locatorFromStored } from "./locator-factory.js";
import { waitForPageReady } from "./page-readiness.js";
import { scopedLocatorPlans, type PlannedScope } from "./scope-planner.js";

type RawScannedElement = {
  tagName: string;
  role?: string;
  visibleText?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  name?: string;
  ariaLabel?: string;
  ariaLabelledByText?: string;
  ariaControls?: string;
  ariaExpanded?: string;
  ariaHasPopup?: string;
  ariaSelected?: string;
  ariaChecked?: string;
  className?: string;
  type?: string;
  contentEditable?: string;
  contextText?: string;
  rowKeyText?: string;
  containerName?: string;
  dialogName?: string;
  scopes?: PlannedScope[];
  cssSelector: string;
};

type LocatorCandidate = {
  locator: string;
  strategy: string;
  count: number;
};

type LocatorPlan = {
  primary: LocatorCandidate;
  fallback?: LocatorCandidate;
  candidates: LocatorCandidate[];
  confidence: number;
  status: "candidate" | "approved";
};

export type ScanPageOptions = {
  name: string;
  url: string;
  out?: string;
  headed?: boolean;
  waitMs: number;
};

export async function scanPage(
  cwd: string,
  config: AiPwConfig,
  options: ScanPageOptions,
): Promise<KbDraft> {
  const storageStatePath = resolveFromCwd(cwd, config.auth.storageState);
  const contextOptions = {
    ignoreHTTPSErrors: config.playwright.ignoreHTTPSErrors,
    ...((await pathExists(storageStatePath))
      ? { storageState: storageStatePath }
      : {}),
  };
  const browser = await chromium.launch({
    headless: options.headed ? false : config.playwright.headless,
  });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  try {
    await page.goto(joinUrl(config.baseUrl, options.url), {
      waitUntil: "networkidle",
      timeout: config.playwright.timeout,
    });

    await waitForPageReady(page, config, options.waitMs);

    const title = await page.title();
    const elements = await scanVisibleElements(page);

    const draft: KbDraft = {
      version: 1,
      generatedAt: new Date().toISOString(),
      page: {
        name: options.name,
        url: options.url,
        title,
      },
      elements,
      businessActions: inferBusinessActions(options.name, elements),
    };
    return enhanceScanDraftWithAi(config, draft);
  } finally {
    await browser.close();
  }
}

export async function scanVisibleElements(
  page: Page,
): Promise<KbDraftElement[]> {
  return normalizeElements(page, await collectRawElements(page));
}

async function collectRawElements(page: Page): Promise<RawScannedElement[]> {
  return page.evaluate<RawScannedElement[]>(() => {
    const selectors = [
      "button",
      "input",
      "textarea",
      "select",
      "a[href]",
      '[role="button"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="combobox"]',
      '[role="textbox"]',
      "[role]",
      "[data-testid]",
      "[onclick]",
      "[tabindex]",
      "[contenteditable]",
      "[aria-label]",
      "[aria-labelledby]",
      "[aria-controls]",
      "[aria-expanded]",
      "[aria-haspopup]",
      "[aria-selected]",
      "[aria-checked]",
    ].join(",");

    function isVisible(element: Element): boolean {
      const htmlElement = element as HTMLElement;
      const style = window.getComputedStyle(htmlElement);
      const rect = htmlElement.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function ownText(element: Element): string {
      return Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ")
        .trim();
    }

    function textOf(element: Element | null): string | undefined {
      const text = element?.textContent?.replace(/\s+/g, " ").trim();
      return text || undefined;
    }

    function labelledByText(element: Element): string | undefined {
      const labelledBy = element.getAttribute("aria-labelledby");
      if (!labelledBy) {
        return undefined;
      }

      const text = labelledBy
        .split(/\s+/)
        .map((id) => textOf(document.getElementById(id)))
        .filter(Boolean)
        .join(" ")
        .trim();
      return text || undefined;
    }

    function accessibleName(element: Element): string | undefined {
      return (
        element.getAttribute("aria-label") ||
        labelledByText(element) ||
        textOf(element.querySelector("h1,h2,h3,h4,h5,h6,[data-title]")) ||
        undefined
      );
    }

    function dialogNameFor(element: Element): string | undefined {
      const dialog = element.closest('dialog,[role="dialog"]');
      if (!dialog || dialog === element) {
        return undefined;
      }

      return accessibleName(dialog)?.slice(0, 80);
    }

    function containerNameFor(element: Element): string | undefined {
      const search = element.closest('[role="search"]');
      if (search && search !== element) {
        return (accessibleName(search) ?? "搜索区域").slice(0, 80);
      }

      const nav = element.closest('nav,[role="navigation"]');
      if (nav && nav !== element) {
        return (accessibleName(nav) ?? "导航区域").slice(0, 80);
      }

      const region = element.closest(
        'section,form,[role="region"],main,header',
      );
      if (region && region !== element) {
        return accessibleName(region)?.slice(0, 80);
      }

      return undefined;
    }

    function scopeTextFor(element: Element): string | undefined {
      const text =
        accessibleName(element) ??
        textOf(element.querySelector("h1,h2,h3,h4,h5,h6,[data-title]")) ??
        Array.from(element.querySelectorAll("label,button,a,th,td"))
          .map((child) => textOf(child))
          .find((value) => value && value.length <= 80) ??
        textOf(element);

      return text?.slice(0, 80);
    }

    function selectorForScope(element: Element): string | undefined {
      const tag = element.tagName.toLowerCase();
      if (tag === "nav" || tag === "section" || tag === "form") {
        return tag;
      }

      const role = element.getAttribute("role");
      if (role && ["search", "region"].includes(role)) {
        return `[role="${CSS.escape(role)}"]`;
      }

      return undefined;
    }

    function containerScopesFor(element: Element): PlannedScope[] {
      const scopes: PlannedScope[] = [];
      const roleContainers: Array<{ element: Element | null; role: string }> = [
        { element: element.closest('[role="search"]'), role: "search" },
        { element: element.closest('nav,[role="navigation"]'), role: "navigation" },
        { element: element.closest('[role="region"]'), role: "region" },
      ];

      for (const item of roleContainers) {
        if (item.element && item.element !== element) {
          scopes.push({
            kind: "role",
            role: item.role,
            name: accessibleName(item.element),
          });
        }
      }

      const container = element.closest(
        '[role="search"],[role="region"],form,section,nav',
      );
      if (container && container !== element) {
        const selector = selectorForScope(container);
        const text = scopeTextFor(container);
        if (selector && text) {
          scopes.push({ kind: "selector", selector, text });
        }
      }

      return scopes;
    }

    function rowKeyFor(element: Element): string | undefined {
      const row = element.closest("tr");
      if (!row) {
        return undefined;
      }

      const cells = Array.from(row.querySelectorAll("th,td"))
        .map((cell) => textOf(cell))
        .filter((text): text is string => Boolean(text));
      return cells.find((text) => text.length > 0 && text.length <= 80);
    }

    function scopesFor(element: Element): PlannedScope[] {
      const scopes: PlannedScope[] = [];
      const rowKeyText = rowKeyFor(element);
      if (rowKeyText) {
        scopes.push({ kind: "row", rowText: rowKeyText });
      }

      const dialog = element.closest('dialog,[role="dialog"]');
      if (dialog && dialog !== element) {
        scopes.push({
          kind: "dialog",
          role: "dialog",
          name: accessibleName(dialog),
        });
      }

      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        const testId = parent.getAttribute("data-testid");
        if (
          testId &&
          !["tr", "tbody", "thead", "tfoot", "table"].includes(
            parent.tagName.toLowerCase(),
          )
        ) {
          scopes.push({ kind: "testId", testId });
          break;
        }
        parent = parent.parentElement;
      }

      scopes.push(...containerScopesFor(element));

      return scopes;
    }

    function labelFor(element: Element): string | undefined {
      const id = element.getAttribute("id");
      if (id) {
        const explicit = document.querySelector(
          `label[for="${CSS.escape(id)}"]`,
        );
        const explicitText = textOf(explicit);
        if (explicitText) {
          return explicitText;
        }
      }

      const wrapped = element.closest("label");
      const wrappedText = wrapped ? ownText(wrapped) : undefined;
      if (wrappedText) {
        return wrappedText;
      }

      return undefined;
    }

    function cssSelectorFor(element: Element): string {
      const testId = element.getAttribute("data-testid");
      if (testId) {
        return `[data-testid="${CSS.escape(testId)}"]`;
      }

      const id = element.getAttribute("id");
      if (id) {
        return `#${CSS.escape(id)}`;
      }

      const parts: string[] = [];
      let current: Element | null = element;
      while (current) {
        const tag = current.tagName.toLowerCase();
        if (current === document.documentElement) {
          parts.unshift(tag);
          break;
        }

        const parent: Element | null = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }

        const currentTagName = current.tagName;
        const siblings = Array.from(parent.children).filter(
          (sibling: Element) => sibling.tagName === currentTagName,
        );
        const index = siblings.indexOf(current) + 1;
        parts.unshift(
          siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag,
        );
        current = parent;
      }

      return parts.join(" > ");
    }

    function isPotentialElement(element: Element): boolean {
      const tag = element.tagName.toLowerCase();
      if (["button", "input", "textarea", "select", "a"].includes(tag))
        return true;
      if (element.getAttribute("data-testid")) return true;
      if (containerTags.has(tag)) return false;
      if (element.getAttribute("onclick")) return true;
      if (element.getAttribute("contenteditable") === "true") return true;
      const tabindex = element.getAttribute("tabindex");
      if (tabindex !== null && Number.parseInt(tabindex, 10) >= 0) return true;
      if (
        element.getAttribute("aria-label") ||
        element.getAttribute("aria-labelledby")
      )
        return true;
      if (
        element.getAttribute("aria-controls") ||
        element.getAttribute("aria-expanded")
      )
        return true;
      if (
        element.getAttribute("aria-haspopup") ||
        element.getAttribute("aria-selected") ||
        element.getAttribute("aria-checked")
      )
        return true;

      const role = element.getAttribute("role");
      return Boolean(role && meaningfulRoles.has(role));
    }

    const meaningfulRoles = new Set([
      "button",
      "link",
      "menuitem",
      "combobox",
      "textbox",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "option",
      "treeitem",
      "searchbox",
      "slider",
      "spinbutton",
    ]);
    const containerTags = new Set([
      "nav",
      "table",
      "thead",
      "tbody",
      "tfoot",
      "tr",
      "section",
      "main",
      "header",
      "footer",
      "form",
      "dialog",
    ]);

    return Array.from(document.querySelectorAll(selectors))
      .filter(isVisible)
      .filter(isPotentialElement)
      .map((element) => {
        const input = element as HTMLInputElement;
        const tagName = element.tagName.toLowerCase();
        const visibleText = (ownText(element) || textOf(element))?.slice(
          0,
          120,
        );
        const label = labelFor(element)?.slice(0, 120);
        const placeholder = input.placeholder || undefined;
        const role = element.getAttribute("role") || implicitRole(element);
        const className =
          typeof element.getAttribute("class") === "string"
            ? (element.getAttribute("class") ?? undefined)
            : undefined;
        const contextText = textOf(
          element.closest("tr") ??
            element.closest("section") ??
            element.parentElement,
        )?.slice(0, 180);

        return {
          tagName,
          role,
          visibleText,
          label,
          placeholder,
          testId: element.getAttribute("data-testid") || undefined,
          name: element.getAttribute("name") || undefined,
          ariaLabel: element.getAttribute("aria-label") || undefined,
          ariaLabelledByText: labelledByText(element)?.slice(0, 120),
          ariaControls: element.getAttribute("aria-controls") || undefined,
          ariaExpanded: element.getAttribute("aria-expanded") || undefined,
          ariaHasPopup: element.getAttribute("aria-haspopup") || undefined,
          ariaSelected: element.getAttribute("aria-selected") || undefined,
          ariaChecked: element.getAttribute("aria-checked") || undefined,
          className: className?.slice(0, 120),
          type: input.type || undefined,
          contentEditable: element.getAttribute("contenteditable") || undefined,
          contextText,
          rowKeyText: rowKeyFor(element),
          containerName: containerNameFor(element),
          dialogName: dialogNameFor(element),
          scopes: scopesFor(element),
          cssSelector: cssSelectorFor(element),
        };
      });

    function implicitRole(element: Element): string | undefined {
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (element as HTMLInputElement).type;
        if (["button", "submit", "reset"].includes(type)) return "button";
        if (["checkbox"].includes(type)) return "checkbox";
        if (["radio"].includes(type)) return "radio";
        return "textbox";
      }
      return undefined;
    }
  });
}

export function defaultDraftPath(cwd: string, pageName: string): string {
  return path.resolve(
    cwd,
    ".ai-pw/kb-drafts",
    `${slugify(pageName) || "page"}.elements.json`,
  );
}

async function normalizeElements(
  page: Page,
  rawElements: RawScannedElement[],
): Promise<KbDraftElement[]> {
  const seenNames = new Map<string, number>();
  const seenLocators = new Set<string>();
  const normalized: KbDraftElement[] = [];
  const planned = await Promise.all(
    rawElements.map((raw) => planLocator(page, raw)),
  );

  for (const [index, raw] of rawElements.entries()) {
    const locatorPlan = planned[index];
    if (!locatorPlan) {
      continue;
    }

    const locatorPrimary = locatorPlan.primary.locator;
    const locatorKey = locatorDedupeKey(raw, locatorPrimary);
    if (seenLocators.has(locatorKey)) {
      continue;
    }
    seenLocators.add(locatorKey);

    const baseName = semanticName(raw);
    const usedCount = seenNames.get(baseName) ?? 0;
    seenNames.set(baseName, usedCount + 1);
    const semantic =
      usedCount === 0 ? baseName : `${baseName} ${usedCount + 1}`;

    normalized.push({
      semanticName: semantic,
      elementType: elementType(raw),
      role: raw.role,
      visibleText: raw.visibleText,
      label: raw.label,
      placeholder: raw.placeholder,
      testId: raw.testId,
      locatorPrimary,
      locatorFallback: locatorPlan.fallback?.locator,
      contextText: locatorContextText(raw, locatorPlan),
      confidence: locatorPlan.confidence,
      status: locatorPlan.status,
    });
  }

  return normalized;
}

async function planLocator(
  page: Page,
  raw: RawScannedElement,
): Promise<LocatorPlan> {
  const candidates = await locatorCandidates(page, raw);
  const scopedCandidates = await scopedLocatorCandidates(page, raw, candidates);
  return chooseLocatorPlan(raw, candidates, scopedCandidates);
}

function chooseLocatorPlan(
  raw: RawScannedElement,
  candidates: LocatorCandidate[],
  scopedCandidates: LocatorCandidate[],
): LocatorPlan {
  const firstUnique = candidates.find((candidate) => candidate.count === 1);
  const firstStableUnique = candidates.find(
    (candidate) => candidate.count === 1 && isStableLocatorCandidate(candidate),
  );
  const preferredScoped = scopedCandidates.find((candidate) =>
    shouldPreferScopedCandidate(candidate, firstStableUnique ?? firstUnique),
  );
  if (preferredScoped) {
    return {
      primary: preferredScoped,
      fallback:
        firstStableUnique ??
        firstUnique ??
        candidates.find(
          (candidate) => candidate.locator !== preferredScoped.locator,
        ),
      candidates: [preferredScoped, ...candidates],
      confidence: confidenceFor(raw, preferredScoped, true),
      status: "approved",
    };
  }

  if (firstStableUnique) {
    return {
      primary: firstStableUnique,
      fallback: candidates.find(
        (candidate) => candidate.locator !== firstStableUnique.locator,
      ),
      candidates,
      confidence: confidenceFor(raw, firstStableUnique, true),
      status: "approved",
    };
  }

  const scoped = scopedCandidates.find((candidate) => candidate.count === 1);
  if (scoped) {
    return {
      primary: scoped,
      fallback: firstUnique ?? candidates[0],
      candidates: [scoped, ...candidates],
      confidence: confidenceFor(raw, scoped, true),
      status: "approved",
    };
  }

  if (firstUnique) {
    return {
      primary: firstUnique,
      fallback: candidates.find(
        (candidate) => candidate.locator !== firstUnique.locator,
      ),
      candidates,
      confidence: Math.min(0.72, confidenceFor(raw, firstUnique, true)),
      status: "candidate",
    };
  }

  const first = candidates[0] ?? {
    locator: `page.locator(${quote(raw.cssSelector)})`,
    strategy: "css",
    count: 0,
  };
  return {
    primary: first,
    fallback: candidates.find(
      (candidate) => candidate.locator !== first.locator,
    ),
    candidates,
    confidence: Math.min(0.6, confidenceFor(raw, first, false)),
    status: "candidate",
  };
}

function isStableLocatorCandidate(candidate: LocatorCandidate): boolean {
  if (candidate.strategy === "css") {
    const selector = storedCssSelector(candidate.locator);
    return (
      selector?.startsWith("#") === true ||
      selector?.startsWith("[data-testid=") === true
    );
  }

  return ["testId", "role", "label", "placeholder", "text"].includes(
    candidate.strategy,
  );
}

function locatorDedupeKey(raw: RawScannedElement, locator: string): string {
  if (locator.includes('${rowText}') && raw.rowKeyText) {
    return `${locator}::row=${raw.rowKeyText}`;
  }

  return locator;
}

function storedCssSelector(locator: string): string | undefined {
  const match = locator.match(/^page\.locator\((.*)\)$/);
  if (!match?.[1]) {
    return undefined;
  }

  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return undefined;
  }
}

async function locatorCandidates(
  page: Page,
  raw: RawScannedElement,
): Promise<LocatorCandidate[]> {
  const locators = candidateLocators(raw);
  const candidates: LocatorCandidate[] = [];
  const seen = new Set<string>();

  for (const item of locators) {
    if (seen.has(item.locator)) {
      continue;
    }
    seen.add(item.locator);
    candidates.push({
      ...item,
      count: await countLocator(page, item.locator),
    });
  }

  return candidates;
}

async function scopedLocatorCandidates(
  page: Page,
  raw: RawScannedElement,
  baseCandidates: LocatorCandidate[],
): Promise<LocatorCandidate[]> {
  const childCandidates = baseCandidates.filter((candidate) =>
    ["testId", "role", "label", "placeholder", "text"].includes(
      candidate.strategy,
    ),
  );
  const plans = scopedLocatorPlans(raw.scopes, childCandidates);
  const candidates: LocatorCandidate[] = [];
  const seen = new Set<string>();

  for (const plan of plans) {
    if (seen.has(plan.locator)) {
      continue;
    }
    seen.add(plan.locator);
    candidates.push({
      locator: plan.locator,
      strategy: plan.strategy,
      count: await countLocator(page, plan.concreteLocator),
    });
  }

  return candidates;
}

function candidateLocators(
  raw: RawScannedElement,
): Array<Omit<LocatorCandidate, "count">> {
  const candidates: Array<Omit<LocatorCandidate, "count">> = [];

  if (raw.testId) {
    candidates.push({
      locator: `page.getByTestId(${quote(raw.testId)})`,
      strategy: "testId",
    });
  }

  const accessibleName =
    raw.ariaLabel ?? raw.ariaLabelledByText ?? raw.visibleText;
  if (raw.role && accessibleName) {
    candidates.push({
      locator: `page.getByRole(${quote(raw.role)}, { name: ${quote(accessibleName)} })`,
      strategy: "role",
    });
  }

  if (raw.label) {
    candidates.push({
      locator: `page.getByLabel(${quote(raw.label)})`,
      strategy: "label",
    });
  }

  if (raw.placeholder) {
    candidates.push({
      locator: `page.getByPlaceholder(${quote(raw.placeholder)})`,
      strategy: "placeholder",
    });
  }

  if (raw.visibleText) {
    candidates.push({
      locator: `page.getByText(${quote(raw.visibleText)})`,
      strategy: "text",
    });
  }

  candidates.push({
    locator: `page.locator(${quote(raw.cssSelector)})`,
    strategy: "css",
  });
  return candidates;
}

async function countLocator(page: Page, locator: string): Promise<number> {
  try {
    return await locatorFromStored(page, locator).count();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function confidenceFor(
  raw: RawScannedElement,
  candidate: LocatorCandidate,
  unique: boolean,
): number {
  const base = candidate.strategy.includes("row-scope")
    ? 0.9
    : candidate.strategy.includes("dialog-scope")
      ? 0.92
      : candidate.strategy.includes("testId-scope")
        ? 0.9
        : candidate.strategy.includes("testId")
          ? 0.95
          : candidate.strategy === "role"
            ? 0.88
            : ["label", "placeholder"].includes(candidate.strategy)
              ? 0.84
              : candidate.strategy === "text"
                ? 0.72
                : 0.55;
  return unique ? base : base - 0.2;
}

function shouldPreferScopedCandidate(
  candidate: LocatorCandidate,
  firstUnique?: LocatorCandidate,
): boolean {
  if (candidate.count !== 1) {
    return false;
  }

  if (candidate.strategy.startsWith("dialog-scope")) {
    return true;
  }

  if (candidate.strategy.startsWith("row-scope")) {
    return true;
  }

  if (candidate.strategy.startsWith("testId-scope")) {
    return !firstUnique || firstUnique.count !== 1;
  }

  if (
    candidate.strategy.startsWith("role-scope") ||
    candidate.strategy.startsWith("selector-scope")
  ) {
    return !firstUnique || !firstUnique.strategy.includes("testId");
  }

  return false;
}

function elementType(raw: RawScannedElement): string {
  if (raw.tagName === "input" && raw.type === "file") return "file";
  if (raw.contentEditable === "true") return "editor";
  if (raw.role === "switch") return "switch";
  if (raw.role === "option") return "option";
  if (raw.role === "tab") return "tab";
  if (raw.role === "treeitem") return "treeitem";
  if (raw.role === "gridcell" || raw.role === "cell") return "gridcell";
  if (raw.role === "menuitem") return "menuitem";
  if (raw.role === "searchbox") return "textbox";
  if (raw.ariaHasPopup === "listbox" || raw.ariaHasPopup === "menu")
    return "combobox";
  if (raw.role === "button") return "button";
  if (raw.role === "link") return "link";
  if (raw.role === "combobox") return "combobox";
  if (raw.role === "checkbox") return "checkbox";
  if (raw.role === "radio") return "radio";
  if (raw.role === "textbox") return "textbox";
  return raw.tagName;
}

function semanticName(raw: RawScannedElement): string {
  const name =
    raw.label ??
    raw.ariaLabel ??
    semanticNameFromTestId(raw.testId) ??
    raw.visibleText ??
    raw.placeholder ??
    raw.name ??
    raw.tagName;
  const suffix = elementTypeName(elementType(raw));
  const nameWithType = name.endsWith(suffix) ? name : `${name}${suffix}`;
  const contextName = semanticContextName(raw, nameWithType);
  if (contextName) {
    return `${contextName}${nameWithType}`;
  }
  return nameWithType;
}

function semanticContextName(
  raw: RawScannedElement,
  semantic: string,
): string | undefined {
  if (raw.testId) {
    return undefined;
  }

  const rowKey = cleanContextName(raw.rowKeyText);
  if (rowKey && !semantic.includes(rowKey)) {
    return rowKey;
  }

  const dialogName = cleanContextName(raw.dialogName);
  if (dialogName && isGenericSemanticName(semantic)) {
    return dialogName;
  }

  const containerName = cleanContextName(raw.containerName);
  if (containerName && isGenericSemanticName(semantic)) {
    return containerName;
  }

  return undefined;
}

function cleanContextName(input?: string): string | undefined {
  const text = input?.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) {
    return undefined;
  }
  return text;
}

function isGenericSemanticName(semantic: string): boolean {
  return /^(新增|新建|创建|编辑|修改|删除|移除|查看|详情|保存|提交|确定|确认|取消|关闭|返回|搜索|查询|筛选|重置|更多|展开|收起|通过|拒绝|下架|上架)(按钮|链接|菜单项|标签|元素)?$/u.test(
    semantic,
  );
}

function semanticNameFromTestId(testId?: string): string | undefined {
  if (!testId) {
    return undefined;
  }

  const dictionary: Record<string, string> = {
    order: "订单",
    user: "用户",
    name: "名称",
    email: "邮箱",
    role: "角色",
    product: "商品",
    table: "列表",
    body: "",
    category: "分类",
    stock: "库存",
    more: "更多",
    offsale: "下架",
    confirm: "确认",
    cancel: "取消",
    settings: "设置",
    notification: "通知",
    frequency: "频率",
    note: "备注",
    save: "保存",
    create: "新增",
    keyword: "关键词",
    toast: "提示消息",
    error: "错误",
    tab: "标签",
    toggle: "开关",
    search: "搜索",
    input: "输入",
    status: "状态",
    filter: "筛选",
    approve: "审批",
    view: "查看",
    edit: "编辑",
    delete: "删除",
    remove: "移除",
    submit: "提交",
    close: "关闭",
    reset: "重置",
    button: "按钮",
  };
  const tokens = testId.split(/[-_]+/).filter(Boolean);
  if (!tokens.some((token) => token in dictionary)) {
    return undefined;
  }

  return tokens
    .filter(
      (token) => !["input", "button", "select", "textarea"].includes(token),
    )
    .map((token) => dictionary[token] ?? token)
    .join("");
}

function elementTypeName(type: string): string {
  const map: Record<string, string> = {
    button: "按钮",
    link: "链接",
    combobox: "下拉框",
    textbox: "输入框",
    checkbox: "复选框",
    radio: "单选框",
    file: "上传控件",
    select: "下拉框",
    textarea: "输入框",
    switch: "开关",
    option: "选项",
    tab: "标签",
    treeitem: "树节点",
    gridcell: "单元格",
    menuitem: "菜单项",
    editor: "编辑器",
  };
  return map[type] ?? "元素";
}

function locatorContextText(
  raw: RawScannedElement,
  locatorPlan: {
    primary: LocatorCandidate;
    fallback?: LocatorCandidate;
    candidates: LocatorCandidate[];
    confidence: number;
    status: "candidate" | "approved";
  },
): string {
  const candidateSummary = locatorPlan.candidates
    .slice(0, 4)
    .map((candidate) => `${candidate.strategy}:${candidate.count}`)
    .join(",");
  return [
    raw.contextText,
    `locatorStrategy=${locatorPlan.primary.strategy}`,
    `locatorCount=${locatorPlan.primary.count}`,
    `rowKey=${raw.rowKeyText ?? ""}`,
    raw.dialogName ? `dialog=${raw.dialogName}` : undefined,
    raw.containerName ? `container=${raw.containerName}` : undefined,
    raw.ariaControls ? `ariaControls=${raw.ariaControls}` : undefined,
    raw.ariaExpanded ? `ariaExpanded=${raw.ariaExpanded}` : undefined,
    raw.ariaSelected ? `ariaSelected=${raw.ariaSelected}` : undefined,
    raw.ariaChecked ? `ariaChecked=${raw.ariaChecked}` : undefined,
    raw.className ? `class=${raw.className}` : undefined,
    candidateSummary ? `locatorCandidates=${candidateSummary}` : undefined,
  ]
    .filter(Boolean)
    .join(" | ");
}

function inferBusinessActions(
  pageName: string,
  elements: KbDraftElement[],
): KbDraft["businessActions"] {
  const hasOrderInput = elements.some(
    (element) => element.testId === "order-search-input",
  );
  const hasSearchButton = elements.some(
    (element) => element.testId === "search-button",
  );

  if (!pageName.includes("订单") || !hasOrderInput || !hasSearchButton) {
    return [];
  }

  return [
    {
      name: "搜索订单",
      description: "按订单编号搜索订单列表",
      inputSchema: {
        orderNo: "string",
      },
      steps: [
        {
          action: "fill",
          target: "订单编号输入框",
          value: "${orderNo}",
        },
        {
          action: "click",
          target: "搜索按钮",
        },
      ],
    },
  ];
}

function quote(input: string): string {
  return JSON.stringify(input);
}

export const pageScannerTestExports = {
  chooseLocatorPlan,
  isStableLocatorCandidate,
  locatorDedupeKey,
  semanticName,
};
