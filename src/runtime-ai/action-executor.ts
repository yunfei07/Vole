import type { CDPSession, Frame, Locator, Page } from '@playwright/test';
import { BackendResolutionError, runtimeError } from './errors.js';
import { ACTION_METHODS, type LocatorDescriptor } from './types.js';

export class ActionExecutor {
  private readonly sessions = new Map<number, CDPSession>();

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
        return deepLocator(scope, descriptor.value);
    }
  }

  descriptorFromSelector(selector: string, frameUrl?: string): LocatorDescriptor {
    if (selector.startsWith('xpath=')) {
      return {
        strategy: 'xpath',
        value: normalizeRootXPath(selector.slice('xpath='.length)),
        frameUrl
      };
    }
    if (selector.startsWith('/')) {
      return { strategy: 'xpath', value: normalizeRootXPath(selector), frameUrl };
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
    if (descriptor.backendNodeId !== undefined) {
      try {
        const resolved = await this.resolveBackendNode(descriptor);
        try {
          const response = await resolved.session.send('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            functionDeclaration: `function () {
              const style = getComputedStyle(this);
              const rect = this.getBoundingClientRect();
              return style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                rect.width > 0 &&
                rect.height > 0;
            }`,
            returnByValue: true
          }) as { result?: { value?: unknown } };
          return response.result?.value === true;
        } finally {
          await resolved.session.send('Runtime.releaseObject', {
            objectId: resolved.objectId
          }).catch(() => undefined);
        }
      } catch (error) {
        if (!isBackendResolutionError(error)) {
          return false;
        }
      }
    }
    try {
      const locator = this.locator(descriptor);
      return await locator.count() === 1 && await locator.isVisible({ timeout: timeoutMs });
    } catch {
      return false;
    }
  }

  async execute(input: {
    method: string;
    locator: LocatorDescriptor;
    value?: string;
    arguments?: ReadonlyArray<string>;
    filePath?: string;
    targetLocator?: LocatorDescriptor;
    timeoutMs: number;
  }): Promise<void> {
    if (!SUPPORTED_ACTIONS.has(input.method)) {
      throw runtimeError('AI_ACT_FAILED', `Method ${input.method} not supported`);
    }
    let locatorDescriptor = input.locator;
    if (input.locator.backendNodeId !== undefined) {
      try {
        await this.executeByBackendNode(input);
        return;
      } catch (error) {
        if (!isBackendResolutionError(error)) {
          throw error;
        }
        locatorDescriptor = withoutBackendNodeId(input.locator);
      }
    }

    const locator = this.locator(locatorDescriptor);
    const timeout = input.timeoutMs;
    switch (input.method) {
      case 'click':
        await locator.click({
          timeout,
          button: asMouseButton(input.arguments?.[0] ?? input.value)
        });
        return;
      case 'tap':
        await this.dispatchLocatorTap(locator);
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
        await this.page.keyboard.press(input.value || 'Enter');
        return;
      case 'scrollIntoView':
        await locator.scrollIntoViewIfNeeded({ timeout });
        return;
      case 'scrollByPixelOffset':
        await locator.hover({ timeout });
        await this.page.mouse.wheel(
          numericArgument(input.arguments?.[0] ?? input.value, 0),
          numericArgument(input.arguments?.[1], 0)
        );
        return;
      case 'mouse.wheel':
        await this.page.mouse.wheel(0, numericArgument(input.arguments?.[0] ?? input.value, 200));
        return;
      case 'scroll':
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
      default:
        throw runtimeError('AI_ACT_FAILED', `Method ${input.method} not supported`);
    }
  }

  async facts(descriptor: LocatorDescriptor): Promise<{
    visible: boolean;
    enabled: boolean;
    text: string;
    value: string;
  }> {
    if (descriptor.backendNodeId !== undefined) {
      try {
        const resolved = await this.resolveBackendNode(descriptor);
        try {
          const response = await resolved.session.send('Runtime.callFunctionOn', {
            objectId: resolved.objectId,
            functionDeclaration: `function () {
              const style = getComputedStyle(this);
              const rect = this.getBoundingClientRect();
              const visible = style.visibility !== 'hidden' &&
                style.display !== 'none' &&
                rect.width > 0 &&
                rect.height > 0;
              return {
                visible,
                enabled: !this.disabled && this.getAttribute('aria-disabled') !== 'true',
                text: String(this.innerText || this.textContent || '').trim(),
                value: typeof this.value === 'string' ? this.value : ''
              };
            }`,
            returnByValue: true
          }) as {
            result?: {
              value?: {
                visible?: boolean;
                enabled?: boolean;
                text?: string;
                value?: string;
              };
            };
          };
          return {
            visible: response.result?.value?.visible === true,
            enabled: response.result?.value?.enabled === true,
            text: response.result?.value?.text ?? '',
            value: response.result?.value?.value ?? ''
          };
        } finally {
          await resolved.session.send('Runtime.releaseObject', {
            objectId: resolved.objectId
          }).catch(() => undefined);
        }
      } catch (error) {
        if (!isBackendResolutionError(error)) {
          throw error;
        }
      }
    }
    const locator = this.locator(descriptor);
    return {
      visible: await locator.isVisible().catch(() => false),
      enabled: await locator.isEnabled().catch(() => false),
      text: (await locator.textContent().catch(() => null))?.trim() ?? '',
      value: await locator.inputValue().catch(() => '')
    };
  }

  async close(): Promise<void> {
    await Promise.all(
      [...new Set(this.sessions.values())].map((session) =>
        session.detach().catch(() => undefined)
      )
    );
    this.sessions.clear();
  }

  private async executeByBackendNode(input: {
    method: string;
    locator: LocatorDescriptor;
    value?: string;
    arguments?: ReadonlyArray<string>;
    filePath?: string;
    targetLocator?: LocatorDescriptor;
    timeoutMs: number;
  }): Promise<void> {
    const resolved = await this.resolveBackendNode(input.locator);
    try {
      switch (input.method) {
        case 'click':
          await this.dispatchBackendClick(
            resolved.session,
            resolved.objectId,
            asMouseButton(input.arguments?.[0] ?? input.value),
            1
          );
          return;
        case 'tap':
          await this.dispatchBackendTap(resolved.session, resolved.objectId);
          return;
        case 'doubleClick':
          await this.dispatchBackendClick(resolved.session, resolved.objectId, 'left', 2);
          return;
        case 'hover':
          await this.dispatchBackendHover(resolved.session, resolved.objectId);
          return;
        case 'fill':
          await this.fillBackendValue(
            resolved.session,
            resolved.objectId,
            input.value ?? input.arguments?.[0] ?? ''
          );
          return;
        case 'type':
          await this.focusBackendNode(resolved.session, resolved.objectId);
          await resolved.session.send('Input.insertText', {
            text: input.value ?? input.arguments?.[0] ?? ''
          });
          return;
        case 'press':
          await this.page.keyboard.press(input.value ?? input.arguments?.[0] ?? 'Enter');
          return;
        case 'selectOption':
        case 'selectOptionFromDropdown':
          await this.selectBackendOption(
            resolved.session,
            resolved.objectId,
            input.value ?? input.arguments?.[0] ?? ''
          );
          return;
        case 'setInputFiles':
          if (!input.filePath) {
            throw runtimeError(
              'AI_ACT_FAILED',
              'setInputFiles requires a filePath supplied by the test plan'
            );
          }
          await resolved.session.send('DOM.setFileInputFiles', {
            objectId: resolved.objectId,
            files: [input.filePath]
          });
          return;
        case 'scrollIntoView':
          await resolved.session.send('DOM.scrollIntoViewIfNeeded', {
            objectId: resolved.objectId
          });
          return;
        case 'scroll':
        case 'scrollTo':
          await this.callBackend(
            resolved.session,
            resolved.objectId,
            `function (raw) {
              const value = String(raw || '0%').trim();
              const percentage = Math.min(100, Math.max(0, parseFloat(value)));
              const target = this === document.documentElement || this === document.body
                ? document.scrollingElement || document.documentElement
                : this;
              target.scrollTo({
                top: Math.max(0, target.scrollHeight - target.clientHeight) * percentage / 100,
                behavior: 'smooth'
              });
            }`,
            [input.value ?? input.arguments?.[0] ?? '0%']
          );
          return;
        case 'nextChunk':
        case 'prevChunk':
          await this.callBackend(
            resolved.session,
            resolved.objectId,
            `async function (direction) {
              const target = this === document.documentElement || this === document.body
                ? document.scrollingElement || document.documentElement
                : this;
              const amount = this === document.documentElement || this === document.body
                ? window.visualViewport?.height || window.innerHeight
                : this.getBoundingClientRect().height;
              const waitForScrollEnd = () => new Promise((resolve) => {
                let last = target.scrollTop || 0;
                const check = () => {
                  const current = target.scrollTop || 0;
                  if (current === last) return resolve();
                  last = current;
                  requestAnimationFrame(check);
                };
                requestAnimationFrame(check);
              });
              target.scrollBy({ top: amount * direction, behavior: 'smooth' });
              await waitForScrollEnd();
            }`,
            [input.method === 'nextChunk' ? 1 : -1]
          );
          return;
        case 'scrollByPixelOffset': {
          const center = await this.backendCenter(resolved.session, resolved.objectId);
          await resolved.session.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: center.x,
            y: center.y,
            deltaX: numericArgument(input.arguments?.[0] ?? input.value, 0),
            deltaY: numericArgument(input.arguments?.[1], 0)
          });
          return;
        }
        case 'mouse.wheel':
          await resolved.session.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: 0,
            y: 0,
            deltaX: 0,
            deltaY: numericArgument(input.arguments?.[0] ?? input.value, 200)
          });
          return;
        case 'dragAndDrop':
          if (!input.targetLocator) {
            throw runtimeError('AI_ACT_FAILED', 'dragAndDrop requires a target element');
          }
          await this.dragBackendNode(
            resolved.session,
            resolved.objectId,
            input.locator,
            input.targetLocator
          );
          return;
        default:
          throw runtimeError('AI_ACT_FAILED', `Method ${input.method} not supported`);
      }
    } finally {
      await resolved.session.send('Runtime.releaseObject', {
        objectId: resolved.objectId
      }).catch(() => undefined);
    }
  }

  private async resolveBackendNode(
    descriptor: LocatorDescriptor
  ): Promise<{ session: CDPSession; objectId: string }> {
    const backendNodeId = descriptor.backendNodeId;
    if (backendNodeId === undefined) {
      throw runtimeError('AI_ACT_FAILED', 'backend node id is required');
    }

    const preferredOrdinal = descriptor.frameOrdinal ?? 0;
    const ordinals = [
      preferredOrdinal,
      ...this.page.frames().map((_, index) => index).filter((index) => index !== preferredOrdinal)
    ];
    let previousError: unknown;
    for (const ordinal of ordinals) {
      try {
        const session = await this.sessionForOrdinal(ordinal);
        await session.send('DOM.enable').catch(() => undefined);
        await session.send('Runtime.enable').catch(() => undefined);
        const response = await session.send('DOM.resolveNode', {
          backendNodeId
        }) as { object?: { objectId?: string } };
        if (response.object?.objectId) {
          return { session, objectId: response.object.objectId };
        }
      } catch (error) {
        previousError = error;
      }
    }
    throw new BackendResolutionError(
      `Unable to resolve backend node ${backendNodeId}`,
      previousError instanceof Error ? previousError.message : previousError
    );
  }

  private async sessionForOrdinal(ordinal: number): Promise<CDPSession> {
    const cached = this.sessions.get(ordinal);
    if (cached) {
      return cached;
    }
    const frame = this.page.frames()[ordinal];
    const target = frame ?? this.page;
    const session = await this.page.context().newCDPSession(target);
    this.sessions.set(ordinal, session);
    return session;
  }

  private async backendCenter(
    session: CDPSession,
    objectId: string
  ): Promise<{ x: number; y: number }> {
    await session.send('DOM.scrollIntoViewIfNeeded', { objectId }).catch(() => undefined);
    const response = await session.send('DOM.getBoxModel', { objectId }) as {
      model?: { content?: number[] };
    };
    const content = response.model?.content;
    if (!content || content.length < 8) {
      throw runtimeError('AI_ACT_FAILED', 'Element is not visible');
    }
    return {
      x: (content[0] + content[2] + content[4] + content[6]) / 4,
      y: (content[1] + content[3] + content[5] + content[7]) / 4
    };
  }

  private async dispatchBackendHover(session: CDPSession, objectId: string): Promise<void> {
    const center = await this.backendCenter(session, objectId);
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: center.x,
      y: center.y,
      button: 'none'
    });
  }

  private async dispatchBackendClick(
    session: CDPSession,
    objectId: string,
    button: 'left' | 'right' | 'middle',
    clickCount: number
  ): Promise<void> {
    const center = await this.backendCenter(session, objectId);
    const dispatches: Array<Promise<unknown>> = [session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: center.x, y: center.y, button: 'none'
    })];
    for (let index = 1; index <= clickCount; index += 1) {
      dispatches.push(session.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: center.x,
        y: center.y,
        button,
        clickCount: index
      }));
      dispatches.push(session.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: center.x,
        y: center.y,
        button,
        clickCount: index
      }));
    }
    await Promise.all(dispatches);
  }

  private async dispatchBackendTap(session: CDPSession, objectId: string): Promise<void> {
    const center = await this.backendCenter(session, objectId);
    await Promise.all([
      session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: center.x, y: center.y }]
      }),
      session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      })
    ]);
  }

  private async dispatchLocatorTap(locator: Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    if (!box) {
      throw runtimeError('AI_ACT_FAILED', 'Element is not visible');
    }
    const session = await this.sessionForOrdinal(0);
    await Promise.all([
      session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }]
      }),
      session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: []
      })
    ]);
  }

  private async focusBackendNode(session: CDPSession, objectId: string): Promise<void> {
    await this.callBackend(session, objectId, 'function () { this.focus(); }', []);
  }

  private async fillBackendValue(
    session: CDPSession,
    objectId: string,
    value: string
  ): Promise<void> {
    const response = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function (rawValue) {
        const element = this;
        if (!element.isConnected) return { status: 'error', reason: 'notconnected' };
        const doc = element.ownerDocument || document;
        const win = doc.defaultView || window;
        const typeInto = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
        const setDirectly = new Set(['color', 'date', 'datetime-local', 'month', 'range', 'time', 'week']);
        const prepare = () => {
          try { element.focus(); } catch {}
          if (element instanceof win.HTMLInputElement || element instanceof win.HTMLTextAreaElement) {
            try { element.select(); return true; } catch {}
            try { element.setSelectionRange(0, String(element.value || '').length); } catch {}
            return true;
          }
          if (element.isContentEditable) {
            const selection = doc.getSelection?.();
            const range = doc.createRange?.();
            if (selection && range) {
              try {
                range.selectNodeContents(element);
                selection.removeAllRanges();
                selection.addRange(range);
              } catch {}
            }
            return true;
          }
          return false;
        };
        const dispatch = (eventValue) => {
          let inputEvent;
          try {
            inputEvent = new win.InputEvent('input', {
              bubbles: true, composed: true, data: eventValue, inputType: 'insertText'
            });
          } catch {
            inputEvent = new win.Event('input', { bubbles: true, composed: true });
          }
          element.dispatchEvent(inputEvent);
          element.dispatchEvent(new win.Event('change', { bubbles: true }));
        };
        if (element instanceof win.HTMLInputElement) {
          const type = String(element.type || '').toLowerCase();
          if (!typeInto.has(type) && !setDirectly.has(type)) {
            return { status: 'error', reason: 'unsupported-input-type:' + type };
          }
          let nextValue = String(rawValue ?? '');
          if (type === 'number') {
            nextValue = nextValue.trim();
            if (nextValue !== '' && Number.isNaN(Number(nextValue))) {
              return { status: 'error', reason: 'invalid-number-value' };
            }
          }
          if (setDirectly.has(type)) {
            nextValue = nextValue.trim();
            prepare();
            const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set;
            if (setter) setter.call(element, nextValue); else element.value = nextValue;
            element._valueTracker?.setValue?.(nextValue);
            if (element.value !== nextValue) return { status: 'error', reason: 'malformed-value' };
            dispatch(nextValue);
            return { status: 'done' };
          }
          prepare();
          return { status: 'needsinput', value: nextValue };
        }
        if (element instanceof win.HTMLTextAreaElement || element.isContentEditable) {
          prepare();
          return { status: 'needsinput', value: String(rawValue ?? '') };
        }
        return { status: 'error', reason: 'unsupported-element' };
      }`,
      arguments: [{ value }],
      returnByValue: true
    }) as {
      result?: { value?: { status?: string; value?: string; reason?: string } };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (response.exceptionDetails) {
      throw runtimeError(
        'AI_ACT_FAILED',
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'Failed to fill element'
      );
    }
    const result = response.result?.value;
    if (result?.status === 'done') return;
    if (result?.status === 'error') {
      throw runtimeError('AI_ACT_FAILED', `Failed to fill element (${result.reason ?? 'unknown'})`);
    }
    if (result?.status === 'needsinput') {
      if ((result.value ?? '').length === 0) {
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Backspace', code: 'Backspace',
          windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
        });
        await session.send('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Backspace', code: 'Backspace',
          windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
        });
      } else {
        await session.send('Input.insertText', { text: result.value ?? value });
      }
      return;
    }
    throw runtimeError('AI_ACT_FAILED', 'Failed to fill element');
  }

  private async selectBackendOption(
    session: CDPSession,
    objectId: string,
    value: string
  ): Promise<void> {
    await this.callBackend(
      session,
      objectId,
      `function (requested) {
        if (!(this instanceof HTMLSelectElement)) {
          throw new Error('Target is not a select element');
        }
        const option = Array.from(this.options).find((candidate) =>
          candidate.value === requested ||
          candidate.label === requested ||
          candidate.textContent?.trim() === requested
        );
        if (!option) throw new Error('Option not found: ' + requested);
        this.value = option.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      [value]
    );
  }

  private async callBackend(
    session: CDPSession,
    objectId: string,
    functionDeclaration: string,
    values: unknown[]
  ): Promise<void> {
    const response = await session.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration,
      arguments: values.map((value) => ({ value })),
      awaitPromise: true,
      returnByValue: true
    }) as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (response.exceptionDetails) {
      throw runtimeError(
        'AI_ACT_FAILED',
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          'browser action failed'
      );
    }
  }

  private async dragBackendNode(
    sourceSession: CDPSession,
    sourceObjectId: string,
    sourceDescriptor: LocatorDescriptor,
    targetDescriptor: LocatorDescriptor
  ): Promise<void> {
    const target = await this.resolveBackendNode(targetDescriptor);
    try {
      const from = await this.absoluteBackendCenter(
        sourceSession,
        sourceObjectId,
        sourceDescriptor
      );
      const to = await this.absoluteBackendCenter(
        target.session,
        target.objectId,
        targetDescriptor
      );
      await this.page.mouse.move(from.x, from.y);
      await this.page.mouse.down({ button: 'left' });
      for (let step = 1; step <= 10; step += 1) {
        await this.page.mouse.move(
          from.x + (to.x - from.x) * step / 10,
          from.y + (to.y - from.y) * step / 10,
          { steps: 1 }
        );
      }
      await this.page.mouse.up({ button: 'left' });
    } finally {
      await target.session.send('Runtime.releaseObject', {
        objectId: target.objectId
      }).catch(() => undefined);
    }
  }

  private async absoluteBackendCenter(
    session: CDPSession,
    objectId: string,
    descriptor: LocatorDescriptor
  ): Promise<{ x: number; y: number }> {
    const point = await this.backendCenter(session, objectId);
    let frame: Frame | undefined = this.page.frames()[descriptor.frameOrdinal ?? 0];
    while (frame && frame !== this.page.mainFrame()) {
      const frameElement = await frame.frameElement();
      const box = await frameElement.boundingBox();
      if (box) {
        point.x += box.x;
        point.y += box.y;
      }
      frame = frame.parentFrame() ?? undefined;
    }
    return point;
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

export const SUPPORTED_ACTIONS: ReadonlySet<string> = new Set(ACTION_METHODS);

function deepLocator(scope: Page | Frame, selector: string): Locator {
  const parts = selector
    .split('>>')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return scope.locator(selector.replace(/^css=/iu, ''));
  }
  let frame = scope.frameLocator(parts[0]!);
  for (const iframeSelector of parts.slice(1, -1)) {
    frame = frame.frameLocator(iframeSelector);
  }
  return frame.locator(parts.at(-1)!);
}

function asMouseButton(value: string | undefined): 'left' | 'right' | 'middle' {
  return value === 'right' || value === 'middle' ? value : 'left';
}

function numericArgument(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function normalizeRootXPath(value: string): string {
  return value.trim() === '/' ? '/html' : value;
}

function withoutBackendNodeId(descriptor: LocatorDescriptor): LocatorDescriptor {
  const { backendNodeId: _backendNodeId, ...rest } = descriptor;
  return rest;
}

function isBackendResolutionError(error: unknown): boolean {
  return error instanceof BackendResolutionError;
}
