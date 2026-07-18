import { createHash } from 'node:crypto';
import type { CDPSession, Page } from '@playwright/test';
import { runtimeError } from './errors.js';
import type { LocatorDescriptor, PageSnapshot, SnapshotNode } from './types.js';

type CdpValue = { value?: unknown };

type AxNode = {
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: CdpValue;
  name?: CdpValue;
  value?: CdpValue;
  properties?: Array<{ name?: string; value?: CdpValue }>;
};

type DomSnapshotDocument = {
  documentURL?: number;
  nodes?: {
    parentIndex?: number[];
    nodeType?: number[];
    nodeName?: number[];
    nodeValue?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
  };
  layout?: {
    nodeIndex?: number[];
    bounds?: number[][];
  };
};

type DomSnapshotResponse = {
  strings?: string[];
  documents?: DomSnapshotDocument[];
};

type AxResponse = {
  nodes?: AxNode[];
};

export class PageSnapshotter {
  private session?: CDPSession;

  constructor(
    private readonly page: Page,
    private readonly maxChars: number
  ) {}

  async capture(selector?: string): Promise<PageSnapshot> {
    try {
      const session = await this.getSession();
      const [dom, ax] = await Promise.all([
        session.send('DOMSnapshot.captureSnapshot', {
          computedStyles: [],
          includePaintOrder: true,
          includeDOMRects: true,
          includeBlendedBackgroundColors: false,
          includeTextColorOpacities: false
        }) as unknown as Promise<DomSnapshotResponse>,
        session.send('Accessibility.getFullAXTree') as Promise<AxResponse>
      ]);
      return buildSnapshot(dom, ax, {
        url: this.page.url(),
        title: await this.page.title(),
        maxChars: this.maxChars,
        selector
      });
    } catch (error) {
      throw runtimeError(
        'AI_SNAPSHOT_FAILED',
        'failed to capture Chromium DOM/AX snapshot',
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async close(): Promise<void> {
    if (!this.session) {
      return;
    }
    try {
      await this.session.detach();
    } catch {
      // The browser may already be closed by Playwright.
    } finally {
      this.session = undefined;
    }
  }

  private async getSession(): Promise<CDPSession> {
    this.session ??= await this.page.context().newCDPSession(this.page);
    return this.session;
  }
}

export function buildSnapshot(
  dom: DomSnapshotResponse,
  ax: AxResponse,
  options: { url: string; title: string; maxChars: number; selector?: string }
): PageSnapshot {
  const strings = dom.strings ?? [];
  const axByBackendId = new Map<number, AxNode>();
  for (const node of ax.nodes ?? []) {
    if (!node.ignored && node.backendDOMNodeId !== undefined) {
      axByBackendId.set(node.backendDOMNodeId, node);
    }
  }

  const snapshotNodes: SnapshotNode[] = [];
  for (const document of dom.documents ?? []) {
    const nodes = document.nodes;
    if (!nodes) {
      continue;
    }
    const documentUrl = stringAt(strings, document.documentURL) || options.url;
    const layoutByNode = new Map<number, [number, number, number, number]>();
    for (const [layoutIndex, nodeIndex] of (document.layout?.nodeIndex ?? []).entries()) {
      const bounds = document.layout?.bounds?.[layoutIndex];
      if (bounds && bounds.length >= 4) {
        layoutByNode.set(nodeIndex, [bounds[0] ?? 0, bounds[1] ?? 0, bounds[2] ?? 0, bounds[3] ?? 0]);
      }
    }

    for (let index = 0; index < (nodes.nodeName?.length ?? 0); index += 1) {
      if (nodes.nodeType?.[index] !== 1) {
        continue;
      }
      const backendNodeId = nodes.backendNodeId?.[index];
      if (backendNodeId === undefined) {
        continue;
      }
      const tag = stringAt(strings, nodes.nodeName?.[index]).toLowerCase();
      const attributes = attributesAt(strings, nodes.attributes?.[index]);
      const axNode = axByBackendId.get(backendNodeId);
      const role = stringValue(axNode?.role);
      const name = stringValue(axNode?.name) || attributes['aria-label'] || attributes.title;
      const value = isSensitiveInput(tag, attributes)
        ? '[REDACTED]'
        : stringValue(axNode?.value) || attributes.value;
      const text = stringAt(strings, nodes.nodeValue?.[index]) || name;
      const bounds = layoutByNode.get(index);
      const visible = Boolean(bounds && bounds[2] > 0 && bounds[3] > 0 && attributes.hidden === undefined);
      const disabled = attributes.disabled !== undefined || axProperty(axNode, 'disabled') === true;
      const locators = buildLocators({
        tag,
        role,
        name,
        text,
        attributes,
        frameUrl: documentUrl,
        xpath: absoluteXPath(index, nodes, strings)
      });

      if (!shouldIncludeNode({ tag, role, name, text, visible, locators })) {
        continue;
      }

      snapshotNodes.push({
        elementId: `e${snapshotNodes.length + 1}`,
        backendNodeId,
        tag,
        role,
        name,
        value,
        text,
        attributes: safeAttributes(attributes),
        visible,
        disabled,
        frameUrl: documentUrl,
        bounds,
        locators
      });
    }
  }

  const serialized = serializeSnapshot(snapshotNodes, options);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(snapshotNodes.map((node) => [
      node.tag,
      node.role,
      node.name,
      node.attributes['data-testid'],
      node.visible
    ])))
    .digest('hex')
    .slice(0, 24);

  return {
    url: options.url,
    title: options.title,
    fingerprint,
    text: serialized,
    nodes: snapshotNodes
  };
}

function shouldIncludeNode(input: {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  visible: boolean;
  locators: LocatorDescriptor[];
}): boolean {
  if (!input.visible) {
    return false;
  }
  const interactiveTags = new Set(['a', 'button', 'input', 'select', 'textarea', 'option', 'summary']);
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'link',
    'menuitem',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox'
  ]);
  return (
    interactiveTags.has(input.tag) ||
    (input.role ? interactiveRoles.has(input.role) : false) ||
    Boolean(input.name || input.text)
  );
}

function buildLocators(input: {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  attributes: Record<string, string>;
  frameUrl?: string;
  xpath?: string;
}): LocatorDescriptor[] {
  const output: LocatorDescriptor[] = [];
  const add = (locator: LocatorDescriptor | undefined): void => {
    if (!locator || output.some((item) => JSON.stringify(item) === JSON.stringify(locator))) {
      return;
    }
    output.push(locator);
  };
  const frameUrl = input.frameUrl;
  const testId = input.attributes['data-testid'] ?? input.attributes['data-test-id'];
  add(testId ? { strategy: 'testId', value: testId, frameUrl } : undefined);
  add(input.role && input.name ? { strategy: 'role', value: input.role, name: input.name, frameUrl } : undefined);
  add(input.attributes['aria-label'] ? { strategy: 'label', value: input.attributes['aria-label'], frameUrl } : undefined);
  add(input.attributes.placeholder ? { strategy: 'placeholder', value: input.attributes.placeholder, frameUrl } : undefined);
  add(input.text && input.text.length <= 120 ? { strategy: 'text', value: input.text, frameUrl } : undefined);
  add(cssLocator(input.tag, input.attributes, frameUrl));
  add(input.xpath ? { strategy: 'xpath', value: input.xpath, frameUrl } : undefined);
  return output;
}

function cssLocator(
  tag: string,
  attributes: Record<string, string>,
  frameUrl?: string
): LocatorDescriptor | undefined {
  if (attributes.id) {
    return { strategy: 'css', value: `#${cssEscape(attributes.id)}`, frameUrl };
  }
  if (attributes.name) {
    return { strategy: 'css', value: `${tag}[name=${JSON.stringify(attributes.name)}]`, frameUrl };
  }
  if (attributes.type && ['input', 'button'].includes(tag)) {
    return { strategy: 'css', value: `${tag}[type=${JSON.stringify(attributes.type)}]`, frameUrl };
  }
  return undefined;
}

function absoluteXPath(
  index: number,
  nodes: NonNullable<DomSnapshotDocument['nodes']>,
  strings: string[]
): string | undefined {
  const parts: string[] = [];
  let current = index;
  while (current >= 0) {
    if (nodes.nodeType?.[current] === 1) {
      const tag = stringAt(strings, nodes.nodeName?.[current]).toLowerCase();
      if (!tag) {
        return undefined;
      }
      let position = 1;
      const parent = nodes.parentIndex?.[current] ?? -1;
      for (let sibling = 0; sibling < current; sibling += 1) {
        if (
          nodes.parentIndex?.[sibling] === parent &&
          stringAt(strings, nodes.nodeName?.[sibling]).toLowerCase() === tag
        ) {
          position += 1;
        }
      }
      parts.unshift(`${tag}[${position}]`);
    }
    current = nodes.parentIndex?.[current] ?? -1;
  }
  return parts.length > 0 ? `/${parts.join('/')}` : undefined;
}

function serializeSnapshot(
  nodes: SnapshotNode[],
  options: { url: string; title: string; maxChars: number; selector?: string }
): string {
  const lines = [
    `url=${options.url}`,
    `title=${options.title}`,
    options.selector ? `requestedScope=${options.selector}` : undefined,
    ...nodes.map((node) => {
      const fields = [
        `[${node.elementId}]`,
        `<${node.tag}>`,
        node.role ? `role=${JSON.stringify(node.role)}` : undefined,
        node.name ? `name=${JSON.stringify(limit(node.name, 180))}` : undefined,
        node.value ? `value=${JSON.stringify(limit(node.value, 180))}` : undefined,
        node.text && node.text !== node.name ? `text=${JSON.stringify(limit(node.text, 180))}` : undefined,
        node.disabled ? 'disabled=true' : undefined,
        node.attributes['data-testid'] ? `testId=${JSON.stringify(node.attributes['data-testid'])}` : undefined
      ];
      return fields.filter(Boolean).join(' ');
    })
  ].filter((line): line is string => Boolean(line));
  const result = lines.join('\n');
  return result.length <= options.maxChars
    ? result
    : `${result.slice(0, options.maxChars)}\n[SNAPSHOT_TRUNCATED]`;
}

function attributesAt(strings: string[], raw?: number[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (let index = 0; index < (raw?.length ?? 0); index += 2) {
    const name = stringAt(strings, raw?.[index]);
    if (name) {
      output[name] = stringAt(strings, raw?.[index + 1]);
    }
  }
  return output;
}

function safeAttributes(attributes: Record<string, string>): Record<string, string> {
  const allowed = new Set([
    'id',
    'class',
    'name',
    'type',
    'role',
    'aria-label',
    'aria-checked',
    'aria-expanded',
    'aria-selected',
    'data-testid',
    'placeholder',
    'title'
  ]);
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => allowed.has(key)));
}

function isSensitiveInput(tag: string, attributes: Record<string, string>): boolean {
  return tag === 'input' && (
    attributes.type?.toLowerCase() === 'password' ||
    /(?:current|new)-password/iu.test(attributes.autocomplete ?? '')
  );
}

function axProperty(node: AxNode | undefined, name: string): unknown {
  return node?.properties?.find((property) => property.name === name)?.value?.value;
}

function stringValue(value: CdpValue | undefined): string | undefined {
  return typeof value?.value === 'string' ? value.value : undefined;
}

function stringAt(strings: string[], index?: number): string {
  return index === undefined || index < 0 ? '' : strings[index] ?? '';
}

function cssEscape(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character.codePointAt(0)?.toString(16)} `);
}

function limit(input: string, max: number): string {
  return input.length <= max ? input : `${input.slice(0, max)}…`;
}
