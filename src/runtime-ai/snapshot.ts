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

const SCOPE_ATTRIBUTE = 'data-vole-snapshot-scope';
const IGNORE_ATTRIBUTE = 'data-vole-snapshot-ignore';

export class PageSnapshotter {
  private session?: CDPSession;

  constructor(
    private readonly page: Page,
    private readonly maxChars: number
  ) {}

  async capture(selector?: string, ignoreSelectors: string[] = []): Promise<PageSnapshot> {
    const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const marked = await this.mark(selector, ignoreSelectors, marker);
      if (selector && marked.scopes === 0) {
        throw runtimeError('AI_SNAPSHOT_FAILED', `snapshot selector matched no elements: ${selector}`);
      }
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
        selector,
        scopeMarker: selector ? marker : undefined,
        ignoreMarker: ignoreSelectors.length > 0 ? marker : undefined
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('AI_')) {
        throw error;
      }
      throw runtimeError(
        'AI_SNAPSHOT_FAILED',
        'failed to capture Chromium DOM/AX snapshot',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      await this.clearMarkers(marker);
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

  private async mark(
    selector: string | undefined,
    ignoreSelectors: string[],
    marker: string
  ): Promise<{ scopes: number; ignored: number }> {
    let scopes = 0;
    let ignored = 0;
    for (const frame of this.page.frames()) {
      if (selector) {
        scopes += await frame.locator(selector).evaluateAll(
          (elements, value) => {
            for (const element of elements) {
              element.setAttribute('data-vole-snapshot-scope', value);
            }
            return elements.length;
          },
          marker
        ).catch(() => 0);
      }
      for (const ignoredSelector of ignoreSelectors) {
        ignored += await frame.locator(ignoredSelector).evaluateAll(
          (elements, value) => {
            for (const element of elements) {
              element.setAttribute('data-vole-snapshot-ignore', value);
            }
            return elements.length;
          },
          marker
        ).catch(() => 0);
      }
    }
    return { scopes, ignored };
  }

  private async clearMarkers(marker: string): Promise<void> {
    for (const frame of this.page.frames()) {
      await frame.locator(
        `[${SCOPE_ATTRIBUTE}=${JSON.stringify(marker)}],` +
        `[${IGNORE_ATTRIBUTE}=${JSON.stringify(marker)}]`
      ).evaluateAll((elements) => {
        for (const element of elements) {
          element.removeAttribute('data-vole-snapshot-scope');
          element.removeAttribute('data-vole-snapshot-ignore');
        }
      }).catch(() => undefined);
    }
  }
}

export function buildSnapshot(
  dom: DomSnapshotResponse,
  ax: AxResponse,
  options: {
    url: string;
    title: string;
    maxChars: number;
    selector?: string;
    scopeMarker?: string;
    ignoreMarker?: string;
  }
): PageSnapshot {
  const strings = dom.strings ?? [];
  const axByBackendId = new Map<number, AxNode>();
  for (const node of ax.nodes ?? []) {
    if (!node.ignored && node.backendDOMNodeId !== undefined) {
      axByBackendId.set(node.backendDOMNodeId, node);
    }
  }

  const snapshotNodes: SnapshotNode[] = [];
  const staticText: string[] = [];
  const elementIdToXpath: Record<string, string> = {};
  const xpathToElementId: Record<string, string> = {};
  const urlMap: Record<string, string> = {};
  for (const [frameOrdinal, document] of (dom.documents ?? []).entries()) {
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

    const attributesByIndex = (nodes.nodeName ?? []).map((_, index) =>
      attributesAt(strings, nodes.attributes?.[index])
    );
    const testIdCounts = new Map<string, number>();
    for (const attributes of attributesByIndex) {
      const testId = attributes['data-testid'] ?? attributes['data-test-id'];
      if (testId) {
        testIdCounts.set(testId, (testIdCounts.get(testId) ?? 0) + 1);
      }
    }
    const scopeRoots = new Set<number>();
    const ignoreRoots = new Set<number>();
    for (const [index, attributes] of attributesByIndex.entries()) {
      if (options.scopeMarker && attributes[SCOPE_ATTRIBUTE] === options.scopeMarker) {
        scopeRoots.add(index);
      }
      if (options.ignoreMarker && attributes[IGNORE_ATTRIBUTE] === options.ignoreMarker) {
        ignoreRoots.add(index);
      }
    }
    const descendantTextByIndex = collectDescendantText(nodes, strings, ignoreRoots);
    if (options.scopeMarker && scopeRoots.size === 0) {
      continue;
    }

    for (let index = 0; index < (nodes.nodeName?.length ?? 0); index += 1) {
      const nodeType = nodes.nodeType?.[index];
      if (nodeType === 3) {
        if (scopeRoots.size > 0 && !isWithin(index, scopeRoots, nodes.parentIndex)) {
          continue;
        }
        if (ignoreRoots.size > 0 && isWithin(index, ignoreRoots, nodes.parentIndex)) {
          continue;
        }
        const bounds = layoutByNode.get(index);
        const value = stringAt(strings, nodes.nodeValue?.[index]).replace(/\s+/gu, ' ').trim();
        if (
          value &&
          bounds &&
          bounds[2] > 0 &&
          bounds[3] > 0 &&
          !isWithinExcludedTag(index, nodes, strings)
        ) {
          staticText.push(`[text frame=${frameOrdinal}] ${limit(value, 500)}`);
        }
        continue;
      }
      if (nodeType !== 1) {
        continue;
      }
      if (scopeRoots.size > 0 && !isWithin(index, scopeRoots, nodes.parentIndex)) {
        continue;
      }
      if (ignoreRoots.size > 0 && isWithin(index, ignoreRoots, nodes.parentIndex)) {
        continue;
      }
      const backendNodeId = nodes.backendNodeId?.[index];
      if (backendNodeId === undefined) {
        continue;
      }
      const tag = stringAt(strings, nodes.nodeName?.[index]).toLowerCase();
      const attributes = attributesByIndex[index] ?? {};
      const axNode = axByBackendId.get(backendNodeId);
      const role = stringValue(axNode?.role);
      const domText = descendantTextByIndex.get(index);
      const explicitName = attributes['aria-label'] || attributes.title;
      const axName = stringValue(axNode?.name);
      const name = explicitName ||
        (isContainerElement(tag, role) ? domText || axName : axName || domText);
      const value = isSensitiveInput(tag, attributes)
        ? '[REDACTED]'
        : stringValue(axNode?.value) || attributes.value;
      const text = domText || stringAt(strings, nodes.nodeValue?.[index]) || name;
      const bounds = layoutByNode.get(index);
      const visible = Boolean(bounds && bounds[2] > 0 && bounds[3] > 0 && attributes.hidden === undefined);
      const disabled = attributes.disabled !== undefined || axProperty(axNode, 'disabled') === true;
      const xpath = absoluteXPath(index, nodes, strings);
      const testId = attributes['data-testid'] ?? attributes['data-test-id'];
      const locators = buildLocators({
        tag,
        role,
        name,
        text,
        attributes,
        frameUrl: documentUrl,
        frameOrdinal,
        xpath,
        preferXpath: Boolean(testId && (testIdCounts.get(testId) ?? 0) > 1)
      });

      if (!shouldIncludeNode({ tag, role, name, text, visible, locators })) {
        continue;
      }

      const elementId = `${frameOrdinal}-${backendNodeId}`;
      const href = attributes.href;
      snapshotNodes.push({
        elementId,
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
        locators,
        xpath,
        href
      });
      if (xpath) {
        elementIdToXpath[elementId] = xpath;
        xpathToElementId[`${frameOrdinal}:${xpath}`] = elementId;
      }
      if (href) {
        urlMap[elementId] = href;
      }
    }
  }

  const serialized = serializeSnapshot(snapshotNodes, staticText, options);
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
    nodes: snapshotNodes,
    elementIdToXpath,
    xpathToElementId,
    urlMap
  };
}

function collectDescendantText(
  nodes: NonNullable<DomSnapshotDocument['nodes']>,
  strings: string[],
  ignoreRoots: Set<number>
): Map<number, string> {
  const pieces = new Map<number, string[]>();
  for (let index = 0; index < (nodes.nodeType?.length ?? 0); index += 1) {
    if (
      nodes.nodeType?.[index] !== 3 ||
      isWithinExcludedTag(index, nodes, strings) ||
      isWithin(index, ignoreRoots, nodes.parentIndex)
    ) {
      continue;
    }
    const text = stringAt(strings, nodes.nodeValue?.[index]).replace(/\s+/gu, ' ').trim();
    if (!text) {
      continue;
    }
    let current = nodes.parentIndex?.[index] ?? -1;
    while (current >= 0) {
      const currentPieces = pieces.get(current) ?? [];
      currentPieces.push(text);
      pieces.set(current, currentPieces);
      current = nodes.parentIndex?.[current] ?? -1;
    }
  }
  return new Map(
    [...pieces.entries()].map(([index, values]) => [
      index,
      limit([...new Set(values)].join(' '), 500)
    ])
  );
}

function isContainerElement(tag: string, role?: string): boolean {
  return ['article', 'aside', 'body', 'div', 'footer', 'form', 'header', 'html', 'main', 'nav', 'section']
    .includes(tag) || ['generic', 'group', 'region'].includes(role ?? '');
}

function isWithin(index: number, roots: Set<number>, parents: number[] | undefined): boolean {
  let current = index;
  while (current >= 0) {
    if (roots.has(current)) {
      return true;
    }
    current = parents?.[current] ?? -1;
  }
  return false;
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
  frameOrdinal?: number;
  xpath?: string;
  preferXpath?: boolean;
}): LocatorDescriptor[] {
  const output: LocatorDescriptor[] = [];
  const add = (locator: LocatorDescriptor | undefined): void => {
    if (!locator || output.some((item) => JSON.stringify(item) === JSON.stringify(locator))) {
      return;
    }
    output.push(locator);
  };
  const frameUrl = input.frameUrl;
  const frameOrdinal = input.frameOrdinal;
  const testId = input.attributes['data-testid'] ?? input.attributes['data-test-id'];
  add(input.preferXpath && input.xpath
    ? { strategy: 'xpath', value: input.xpath, frameUrl, frameOrdinal }
    : undefined);
  add(testId ? { strategy: 'testId', value: testId, frameUrl, frameOrdinal } : undefined);
  add(input.role && input.name
    ? { strategy: 'role', value: input.role, name: input.name, frameUrl, frameOrdinal }
    : undefined);
  add(input.attributes['aria-label']
    ? { strategy: 'label', value: input.attributes['aria-label'], frameUrl, frameOrdinal }
    : undefined);
  add(input.attributes.placeholder
    ? { strategy: 'placeholder', value: input.attributes.placeholder, frameUrl, frameOrdinal }
    : undefined);
  add(input.text && input.text.length <= 120
    ? { strategy: 'text', value: input.text, frameUrl, frameOrdinal }
    : undefined);
  add(cssLocator(input.tag, input.attributes, frameUrl, frameOrdinal));
  add(!input.preferXpath && input.xpath
    ? { strategy: 'xpath', value: input.xpath, frameUrl, frameOrdinal }
    : undefined);
  return output;
}

function cssLocator(
  tag: string,
  attributes: Record<string, string>,
  frameUrl?: string,
  frameOrdinal?: number
): LocatorDescriptor | undefined {
  if (attributes.id) {
    return { strategy: 'css', value: `#${cssEscape(attributes.id)}`, frameUrl, frameOrdinal };
  }
  if (attributes.name) {
    return {
      strategy: 'css',
      value: `${tag}[name=${JSON.stringify(attributes.name)}]`,
      frameUrl,
      frameOrdinal
    };
  }
  if (attributes.type && ['input', 'button'].includes(tag)) {
    return {
      strategy: 'css',
      value: `${tag}[type=${JSON.stringify(attributes.type)}]`,
      frameUrl,
      frameOrdinal
    };
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
      if (parent >= 0) {
        for (let sibling = 0; sibling < current; sibling += 1) {
          if (
            nodes.nodeType?.[sibling] === 1 &&
            nodes.parentIndex?.[sibling] === parent &&
            stringAt(strings, nodes.nodeName?.[sibling]).toLowerCase() === tag
          ) {
            position += 1;
          }
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
  staticText: string[],
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
    }),
    ...staticText
  ].filter((line): line is string => Boolean(line));
  const result = lines.join('\n');
  return result.length <= options.maxChars
    ? result
    : `${result.slice(0, options.maxChars)}\n[SNAPSHOT_TRUNCATED]`;
}

function isWithinExcludedTag(
  index: number,
  nodes: NonNullable<DomSnapshotDocument['nodes']>,
  strings: string[]
): boolean {
  const excluded = new Set(['script', 'style', 'noscript', 'template']);
  let current = nodes.parentIndex?.[index] ?? -1;
  while (current >= 0) {
    const tag = stringAt(strings, nodes.nodeName?.[current]).toLowerCase();
    if (excluded.has(tag)) {
      return true;
    }
    current = nodes.parentIndex?.[current] ?? -1;
  }
  return false;
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
