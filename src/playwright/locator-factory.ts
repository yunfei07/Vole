import type { Locator, Page } from '@playwright/test';

export function locatorFromStored(page: Page, locator: string): Locator {
  const deep = locatorFromDeepSelector(page, locator);
  if (deep) return deep;

  if (locator.startsWith('xpath=') || locator.startsWith('css=')) {
    return page.locator(locator);
  }

  if (locator.startsWith('//') || locator.startsWith('/')) {
    return page.locator(`xpath=${locator}`);
  }

  const rowScoped = locator.match(
    /^page\.getByRole\((["'])row\1\)\.filter\(\{\s*hasText:\s*(["'])(.*?)\2\s*\}\)\.(.+)$/
  );
  if (rowScoped?.[3] && rowScoped[4]) {
    if (rowScoped[3] === '${rowText}') {
      throw new Error(`Locator template requires rowText context: ${locator}`);
    }

    return applyChildLocator(page.getByRole('row').filter({ hasText: rowScoped[3] }), rowScoped[4]);
  }

  const dialogScoped = locator.match(/^page\.getByRole\((["'])dialog\1(?:,\s*\{\s*name:\s*(["'])(.*?)\2\s*\})?\)\.(.+)$/);
  if (dialogScoped?.[4]) {
    const root = dialogScoped[3] ? page.getByRole('dialog', { name: dialogScoped[3] }) : page.getByRole('dialog');
    return applyChildLocator(root, dialogScoped[4]);
  }

  const testIdScoped = locator.match(/^page\.getByTestId\((["'])(.*?)\1\)\.(.+)$/);
  if (testIdScoped?.[2] && testIdScoped[3]) {
    return applyChildLocator(page.getByTestId(testIdScoped[2]), testIdScoped[3]);
  }

  const roleScoped = locator.match(/^page\.getByRole\((["'])(.*?)\1(?:,\s*\{\s*name:\s*(["'])(.*?)\3\s*\})?\)\.(.+)$/);
  if (roleScoped?.[2] && roleScoped[5]) {
    const root = roleScoped[4]
      ? page.getByRole(roleScoped[2] as Parameters<Page['getByRole']>[0], { name: roleScoped[4] })
      : page.getByRole(roleScoped[2] as Parameters<Page['getByRole']>[0]);
    return applyChildLocator(root, roleScoped[5]);
  }

  const selectorTextScoped = locator.match(/^page\.locator\((.*)\)\.filter\(\{\s*hasText:\s*(["'])(.*?)\2\s*\}\)\.(.+)$/);
  if (selectorTextScoped?.[1] && selectorTextScoped[3] && selectorTextScoped[4]) {
    return applyChildLocator(
      page.locator(parseStringArgument(selectorTextScoped[1])).filter({ hasText: selectorTextScoped[3] }),
      selectorTextScoped[4]
    );
  }

  const testId = locator.match(/^page\.getByTestId\((["'])(.*?)\1\)$/);
  if (testId?.[2]) {
    return page.getByTestId(testId[2]);
  }

  const role = locator.match(/^page\.getByRole\((["'])(.*?)\1,\s*\{\s*name:\s*(["'])(.*?)\3\s*\}\)$/);
  if (role?.[2] && role[4]) {
    return page.getByRole(role[2] as Parameters<Page['getByRole']>[0], { name: role[4] });
  }

  const label = locator.match(/^page\.getByLabel\((["'])(.*?)\1\)$/);
  if (label?.[2]) {
    return page.getByLabel(label[2]);
  }

  const placeholder = locator.match(/^page\.getByPlaceholder\((["'])(.*?)\1\)$/);
  if (placeholder?.[2]) {
    return page.getByPlaceholder(placeholder[2]);
  }

  const text = locator.match(/^page\.getByText\((["'])(.*?)\1\)$/);
  if (text?.[2]) {
    return page.getByText(text[2]);
  }

  const css = locator.match(/^page\.locator\((.*)\)$/);
  if (css?.[1]) {
    return page.locator(parseStringArgument(css[1]));
  }

  throw new Error(`Unsupported locator format: ${locator}`);
}

function locatorFromDeepSelector(page: Page, locator: string): Locator | undefined {
  const trimmed = locator.trim();
  if (trimmed.includes('>>')) {
    const parts = trimmed.split('>>').map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) return undefined;
    let frame = page.frameLocator(normalizeFrameSelector(parts[0] ?? ''));
    for (let index = 1; index < parts.length - 1; index += 1) {
      frame = frame.frameLocator(normalizeFrameSelector(parts[index] ?? ''));
    }
    return frame.locator(normalizeLocatorSelector(parts[parts.length - 1] ?? ''));
  }

  const rawXpath = trimmed.startsWith('xpath=') ? trimmed.slice('xpath='.length).trim() : trimmed;
  if (!rawXpath.startsWith('/') || !/\/iframe(?:\[|\b)/iu.test(rawXpath)) {
    return undefined;
  }

  const parts = splitIframeXPath(rawXpath);
  if (parts.frameSelectors.length === 0) return undefined;

  let frame = page.frameLocator(`xpath=${parts.frameSelectors[0]}`);
  for (let index = 1; index < parts.frameSelectors.length; index += 1) {
    frame = frame.frameLocator(`xpath=${parts.frameSelectors[index]}`);
  }
  return frame.locator(`xpath=${parts.leafSelector || '/'}`);
}

function normalizeFrameSelector(input: string): string {
  if (input.startsWith('/') || input.startsWith('xpath=')) {
    return input.startsWith('xpath=') ? input : `xpath=${input}`;
  }
  return input;
}

function normalizeLocatorSelector(input: string): string {
  if (input.startsWith('/') || input.startsWith('xpath=')) {
    return input.startsWith('xpath=') ? input : `xpath=${input}`;
  }
  if (input.startsWith('css=')) {
    return input.slice('css='.length);
  }
  return input;
}

type XPathStep = {
  axis: '/' | '//';
  raw: string;
  name: string;
};

function splitIframeXPath(xpath: string): { frameSelectors: string[]; leafSelector: string } {
  const steps = parseXPathSteps(xpath);
  const frameSelectors: string[] = [];
  let buffer: XPathStep[] = [];

  for (const step of steps) {
    buffer.push(step);
    if (step.name === 'iframe' || step.name.endsWith(':iframe')) {
      frameSelectors.push(buildXPath(buffer));
      buffer = [];
    }
  }

  return {
    frameSelectors,
    leafSelector: buildXPath(buffer)
  };
}

function parseXPathSteps(xpath: string): XPathStep[] {
  const normalized = xpath.trim().replace(/^xpath=/iu, '');
  const steps: XPathStep[] = [];
  let index = 0;
  while (index < normalized.length) {
    let axis: '/' | '//' = '/';
    if (normalized.startsWith('//', index)) {
      axis = '//';
      index += 2;
    } else if (normalized[index] === '/') {
      index += 1;
    }

    const start = index;
    while (index < normalized.length && normalized[index] !== '/') {
      index += 1;
    }
    const raw = normalized.slice(start, index).trim();
    if (!raw) continue;
    const name = raw.replace(/\[\d+\]\s*$/u, '').replace(/^\*\[name\(\)=['"]([^'"]+)['"]\]$/u, '$1').toLowerCase();
    steps.push({ axis, raw, name });
  }
  return steps;
}

function buildXPath(steps: XPathStep[]): string {
  if (steps.length === 0) return '/';
  return steps.map((step) => `${step.axis}${step.raw}`).join('');
}

function applyChildLocator(root: Locator, child: string): Locator {
  const testId = child.match(/^getByTestId\((["'])(.*?)\1\)$/);
  if (testId?.[2]) {
    return root.getByTestId(testId[2]);
  }

  const role = child.match(/^getByRole\((["'])(.*?)\1,\s*\{\s*name:\s*(["'])(.*?)\3\s*\}\)$/);
  if (role?.[2] && role[4]) {
    return root.getByRole(role[2] as Parameters<Locator['getByRole']>[0], { name: role[4] });
  }

  const roleWithoutName = child.match(/^getByRole\((["'])(.*?)\1\)$/);
  if (roleWithoutName?.[2]) {
    return root.getByRole(roleWithoutName[2] as Parameters<Locator['getByRole']>[0]);
  }

  const label = child.match(/^getByLabel\((["'])(.*?)\1\)$/);
  if (label?.[2]) {
    return root.getByLabel(label[2]);
  }

  const placeholder = child.match(/^getByPlaceholder\((["'])(.*?)\1\)$/);
  if (placeholder?.[2]) {
    return root.getByPlaceholder(placeholder[2]);
  }

  const text = child.match(/^getByText\((["'])(.*?)\1\)$/);
  if (text?.[2]) {
    return root.getByText(text[2]);
  }

  throw new Error(`Unsupported scoped locator child: ${child}`);
}

function parseStringArgument(input: string): string {
  try {
    return JSON.parse(input) as string;
  } catch {
    const simple = input.match(/^(["'])(.*?)\1$/);
    if (simple?.[2]) {
      return simple[2];
    }
    throw new Error(`Unsupported locator string argument: ${input}`);
  }
}
