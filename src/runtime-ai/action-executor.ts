import type { Frame, Locator, Page } from '@playwright/test';
import { runtimeError } from './errors.js';
import type { AiActionMethod, LocatorDescriptor } from './types.js';

export class ActionExecutor {
  constructor(private readonly page: Page) {}

  locator(descriptor: LocatorDescriptor): Locator {
    const scope = this.scopeFor(descriptor.frameUrl);
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
        await locator.selectOption({ label: input.value ?? '' }, { timeout });
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
        await locator.scrollIntoViewIfNeeded({ timeout });
        return;
      case 'nextChunk':
        await this.page.mouse.wheel(0, 700);
        return;
      case 'prevChunk':
        await this.page.mouse.wheel(0, -700);
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

  private scopeFor(frameUrl?: string): Page | Frame {
    if (!frameUrl || sameDocumentUrl(frameUrl, this.page.url())) {
      return this.page;
    }
    return this.page.frames().find((frame) => sameDocumentUrl(frame.url(), frameUrl)) ?? this.page;
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
