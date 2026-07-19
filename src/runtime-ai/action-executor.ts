import type { Frame, Locator, Page } from '@playwright/test';
import { runtimeError } from './errors.js';
import type { AiActionMethod, LocatorDescriptor } from './types.js';

export class ActionExecutor {
  constructor(private readonly page: Page) {}

  locator(descriptor: LocatorDescriptor): Locator {
    const scope = this.scopeFor(descriptor.frameUrl, descriptor.frameOrdinal);
    switch (descriptor.strategy) {
      case 'testId':
        return scope.getByTestId(descriptor.value);
      case 'role':
        return scope.getByRole(descriptor.value as Parameters<Frame['getByRole']>[0], {
          name: descriptor.name,
          exact: true
        });
      case 'label':
        return scope.getByLabel(descriptor.value, { exact: true });
      case 'placeholder':
        return scope.getByPlaceholder(descriptor.value, { exact: true });
      case 'text':
        return scope.getByText(descriptor.value, { exact: true });
      case 'xpath':
        return scope.locator(`xpath=${descriptor.value}`);
      case 'css':
        return scope.locator(descriptor.value);
    }
  }

  descriptorFromSelector(selector: string, frameUrl?: string): LocatorDescriptor {
    if (selector.startsWith('xpath=')) {
      return { strategy: 'xpath', value: selector.slice('xpath='.length), frameUrl };
    }
    if (selector.startsWith('/')) {
      return { strategy: 'xpath', value: selector, frameUrl };
    }
    const testId = selector.match(/^\[data-testid=(.+)\]$/u);
    if (testId?.[1]) {
      return {
        strategy: 'testId',
        value: parseSerializedValue(testId[1]),
        frameUrl
      };
    }
    const role = selector.match(/^role=([^\[]+)\[name=(.+)\]$/u);
    if (role?.[1] && role[2]) {
      return {
        strategy: 'role',
        value: role[1],
        name: parseSerializedValue(role[2]),
        frameUrl
      };
    }
    for (const strategy of ['label', 'placeholder', 'text'] as const) {
      const prefix = `${strategy}=`;
      if (selector.startsWith(prefix)) {
        return {
          strategy,
          value: parseSerializedValue(selector.slice(prefix.length)),
          frameUrl
        };
      }
    }
    return { strategy: 'css', value: selector, frameUrl };
  }

  selector(descriptor: LocatorDescriptor): string {
    return descriptor.strategy === 'xpath'
      ? `xpath=${descriptor.value}`
      : descriptor.strategy === 'css'
        ? descriptor.value
        : descriptor.strategy === 'testId'
          ? `[data-testid=${JSON.stringify(descriptor.value)}]`
          : descriptor.strategy === 'role'
            ? `role=${descriptor.value}[name=${JSON.stringify(descriptor.name ?? '')}]`
            : `${descriptor.strategy}=${JSON.stringify(descriptor.value)}`;
  }

  async isUsable(descriptor: LocatorDescriptor, timeoutMs = 1500): Promise<boolean> {
    try {
      const locator = this.locator(descriptor);
      return await locator.count() === 1 && await locator.isVisible({ timeout: timeoutMs });
    } catch {
      return false;
    }
  }

  async execute(input: {
    method: AiActionMethod;
    locator: LocatorDescriptor;
    value?: string;
    filePath?: string;
    targetLocator?: LocatorDescriptor;
    timeoutMs: number;
  }): Promise<void> {
    const locator = this.locator(input.locator);
    const timeout = input.timeoutMs;
    switch (input.method) {
      case 'click':
        await locator.click({ timeout });
        return;
      case 'doubleClick':
        await locator.dblclick({ timeout });
        return;
      case 'hover':
        await locator.hover({ timeout });
        return;
      case 'fill':
        await locator.fill(input.value ?? '', { timeout });
        return;
      case 'type':
        await locator.pressSequentially(input.value ?? '', { timeout });
        return;
      case 'selectOption':
      case 'selectOptionFromDropdown':
        await locator.selectOption(input.value ?? '', { timeout });
        return;
      case 'setInputFiles':
        if (!input.filePath) {
          throw runtimeError('AI_ACT_FAILED', 'setInputFiles requires a filePath supplied by the test plan');
        }
        await locator.setInputFiles(input.filePath, { timeout });
        return;
      case 'press':
        await locator.press(input.value || 'Enter', { timeout });
        return;
      case 'scrollTo':
        await locator.evaluate((element, rawValue) => {
          const value = String(rawValue ?? '').trim();
          if (!value) {
            element.scrollIntoView({ block: 'center', inline: 'nearest' });
            return;
          }
          const percentage = Number.parseFloat(value.replace(/%$/u, ''));
          if (!Number.isFinite(percentage)) {
            element.scrollIntoView({ block: 'center', inline: 'nearest' });
            return;
          }
          const scrollable = element as HTMLElement;
          scrollable.scrollTo({
            top: Math.max(0, scrollable.scrollHeight - scrollable.clientHeight) *
              Math.min(100, Math.max(0, percentage)) / 100,
            behavior: 'smooth'
          });
        }, input.value);
        return;
      case 'nextChunk':
        await scrollElementChunk(locator, 1);
        return;
      case 'prevChunk':
        await scrollElementChunk(locator, -1);
        return;
      case 'dragAndDrop':
        if (!input.targetLocator) {
          throw runtimeError('AI_ACT_FAILED', 'dragAndDrop requires a target element');
        }
        await locator.dragTo(this.locator(input.targetLocator), { timeout });
        return;
    }
  }

  async facts(descriptor: LocatorDescriptor): Promise<{
    visible: boolean;
    enabled: boolean;
    text: string;
    value: string;
  }> {
    const locator = this.locator(descriptor);
    return {
      visible: await locator.isVisible().catch(() => false),
      enabled: await locator.isEnabled().catch(() => false),
      text: (await locator.textContent().catch(() => null))?.trim() ?? '',
      value: await locator.inputValue().catch(() => '')
    };
  }

  private scopeFor(frameUrl?: string, frameOrdinal?: number): Page | Frame {
    if (frameOrdinal !== undefined && frameOrdinal > 0) {
      return this.page.frames()[frameOrdinal] ?? this.page;
    }
    if (!frameUrl || sameDocumentUrl(frameUrl, this.page.url())) {
      return this.page;
    }
    return this.page.frames().find((frame) => sameDocumentUrl(frame.url(), frameUrl)) ?? this.page;
  }
}

async function scrollElementChunk(locator: Locator, direction: 1 | -1): Promise<void> {
  await locator.evaluate((element, dir) => {
    const target = element as HTMLElement;
    if (target === document.documentElement || target === document.body) {
      window.scrollBy({
        top: (window.visualViewport?.height ?? window.innerHeight) * dir,
        behavior: 'smooth'
      });
      return;
    }
    target.scrollBy({
      top: target.getBoundingClientRect().height * dir,
      behavior: 'smooth'
    });
  }, direction);
}

function parseSerializedValue(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

function sameDocumentUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return left === right;
  }
}
