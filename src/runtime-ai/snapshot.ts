import { createHash } from 'node:crypto';
import type { CDPSession, Frame, Page } from '@playwright/test';
import { runtimeError } from './errors.js';
import type { LocatorDescriptor, PageSnapshot, SnapshotNode } from './types.js';

type CdpValue = { value?: unknown };

type AxNode = {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: CdpValue;
  name?: CdpValue;
  description?: CdpValue;
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
    shadowRootType?: {
      index?: number[];
      value?: number[];
    };
    contentDocumentIndex?: {
      index?: number[];
      value?: number[];
    };
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
  frameOrdinal?: number;
  nodes?: AxNode[];
};

type CdpFrameTree = {
  frame: { id: string; url?: string };
  childFrames?: CdpFrameTree[];
};

type CdpDomNode = {
  nodeId?: number;
  backendNodeId?: number;
  childNodeCount?: number;
  isScrollable?: boolean;
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  templateContent?: CdpDomNode;
  pseudoElements?: CdpDomNode[];
};

export class PageSnapshotter {
  private readonly sessions = new Map<number, CDPSession>();

  constructor(
    private readonly page: Page,
    private readonly maxChars: number
  ) {}

  async capture(selector?: string, ignoreSelectors: string[] = []): Promise<PageSnapshot> {
    try {
      const [scopeXpaths, ignoreXpaths] = await Promise.all([
        selector ? this.resolveSelectorXpaths(selector) : Promise.resolve(new Map()),
        this.resolveIgnoreXpaths(ignoreSelectors)
      ]);
      const session = await this.getSession();
      const [dom, frameTreeResponse] = await Promise.all([
        session.send('DOMSnapshot.captureSnapshot', {
          computedStyles: [],
          includePaintOrder: true,
          includeDOMRects: true,
          includeBlendedBackgroundColors: false,
          includeTextColorOpacities: false
        }) as unknown as Promise<DomSnapshotResponse>,
        (session.send('Page.getFrameTree') as Promise<{ frameTree: CdpFrameTree }>).catch(() => ({
          frameTree: { frame: { id: '', url: this.page.url() } }
        }))
      ]);
      const frameTree = frameTreeResponse?.frameTree ?? {
        frame: { id: '', url: this.page.url() }
      };
      const [ax, scrollableElementIds] = await Promise.all([
        this.captureAxTrees(frameTree),
        this.captureScrollableElements()
      ]);
      return buildSnapshot(dom, ax, {
        url: this.page.url(),
        title: await this.page.title(),
        maxChars: this.maxChars,
        frameUrls: this.page.frames().map((frame) => frame.url()),
        selector,
        scopeXpaths: selector && scopeXpaths.size > 0 ? scopeXpaths : undefined,
        ignoreXpaths: ignoreXpaths.size > 0 ? ignoreXpaths : undefined,
        scrollableElementIds
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
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      [...new Set(this.sessions.values())].map((session) =>
        session.detach().catch(() => undefined)
      )
    );
    this.sessions.clear();
  }

  private async getSession(): Promise<CDPSession> {
    return this.getFrameSession(0);
  }

  private async getFrameSession(frameOrdinal: number): Promise<CDPSession> {
    const cached = this.sessions.get(frameOrdinal);
    if (cached) return cached;
    const target = this.page.frames()[frameOrdinal] ?? this.page;
    const session = await this.page.context().newCDPSession(target).catch(async (error) => {
      if (frameOrdinal === 0) throw error;
      return this.getSession();
    });
    this.sessions.set(frameOrdinal, session);
    return session;
  }

  private async captureAxTrees(frameTree: CdpFrameTree): Promise<AxResponse[]> {
    const rootSession = await this.getSession();
    const protocolFrames = flattenFrameTree(frameTree);
    const pageFrames = this.page.frames();
    const frames = pageFrames.length > 0 ? pageFrames : [undefined];
    return Promise.all(frames.map(async (frame, frameOrdinal) => {
      const frameUrl = frame?.url() ?? this.page.url();
      const positionalFrame = protocolFrames[frameOrdinal];
      const protocolFrame = positionalFrame && sameDocumentUrl(positionalFrame.url ?? '', frameUrl)
        ? positionalFrame
        : protocolFrames.find((candidate) => sameDocumentUrl(candidate.url ?? '', frameUrl)) ??
          positionalFrame;
      if (protocolFrame?.id) {
        try {
          const response = await rootSession.send('Accessibility.getFullAXTree', {
            frameId: protocolFrame.id
          }) as AxResponse;
          return { frameOrdinal, nodes: response.nodes ?? [] };
        } catch {
          // OOPIF frames belong to their own CDP target.
        }
      }
      const session = await this.getFrameSession(frameOrdinal);
      const response = await session.send('Accessibility.getFullAXTree') as AxResponse;
      return { frameOrdinal, nodes: response.nodes ?? [] };
    }));
  }

  private async captureScrollableElements(): Promise<Set<string>> {
    const pageFrames = this.page.frames();
    const ordinals = pageFrames.length > 0 ? pageFrames.map((_, index) => index) : [0];
    const output = new Set<string>();
    const sessionByOrdinal = await Promise.all(ordinals.map(async (frameOrdinal) => ({
      frameOrdinal,
      session: await this.getFrameSession(frameOrdinal)
    })));
    const ordinalsBySession = new Map<CDPSession, number[]>();
    for (const { frameOrdinal, session } of sessionByOrdinal) {
      const values = ordinalsBySession.get(session) ?? [];
      values.push(frameOrdinal);
      ordinalsBySession.set(session, values);
    }
    await Promise.all([...ordinalsBySession].map(async ([session, sessionOrdinals]) => {
      const root = await getDomTreeWithFallback(session).catch(() => undefined);
      const visit = (node: CdpDomNode | undefined): void => {
        if (!node) return;
        if (node.isScrollable && node.backendNodeId !== undefined) {
          for (const frameOrdinal of sessionOrdinals) {
            output.add(`${frameOrdinal}-${node.backendNodeId}`);
          }
        }
        for (const child of node.children ?? []) visit(child);
        for (const shadow of node.shadowRoots ?? []) visit(shadow);
        for (const pseudo of node.pseudoElements ?? []) visit(pseudo);
        visit(node.contentDocument);
        visit(node.templateContent);
      };
      visit(root);
    }));
    return output;
  }

  private async resolveIgnoreXpaths(
    selectors: string[]
  ): Promise<Map<number, Set<string>>> {
    const output = new Map<number, Set<string>>();
    for (const selector of selectors) {
      const resolved = await this.resolveSelectorXpaths(selector).catch(() => new Map());
      for (const [ordinal, xpaths] of resolved) {
        const values = output.get(ordinal) ?? new Set<string>();
        for (const xpath of xpaths) values.add(xpath);
        output.set(ordinal, values);
      }
    }
    return output;
  }

  private async resolveSelectorXpaths(selector: string): Promise<Map<number, Set<string>>> {
    const parts = selector.split('>>').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return new Map();
    let frames = [this.page.mainFrame()];
    for (const iframeSelector of parts.slice(0, -1)) {
      const children = await Promise.all(frames.map(async (frame) => {
        const handles = await frame.locator(stripCssPrefix(iframeSelector)).elementHandles();
        return Promise.all(handles.map((handle) => handle.contentFrame()));
      }));
      frames = children.flat().filter((frame): frame is Frame => frame !== null);
      if (frames.length === 0) return new Map();
    }
    const tail = normalizePlaywrightSelector(parts.at(-1)!);
    const allFrames = this.page.frames();
    const output = new Map<number, Set<string>>();
    await Promise.all(frames.map(async (frame) => {
      const xpaths = await frame.locator(tail).evaluateAll((elements) => elements.map((element) => {
        const pieces: Array<{ value: string; shadow?: boolean }> = [];
        let current: Element | null = element;
        while (current) {
          const tag = current.tagName.toLowerCase();
          let position = 1;
          let sibling = current.previousElementSibling;
          while (sibling) {
            if (sibling.tagName === current.tagName) position += 1;
            sibling = sibling.previousElementSibling;
          }
          pieces.push({ value: `${tag}[${position}]` });
          const root: Node = current.getRootNode();
          if (root instanceof ShadowRoot) {
            pieces.push({ value: '', shadow: true });
            current = root.host;
          } else {
            current = current.parentElement;
          }
        }
        pieces.reverse();
        let xpath = '';
        for (const piece of pieces) {
          if (piece.shadow) {
            xpath = xpath.endsWith('/') ? `${xpath}/` : `${xpath}//`;
          } else {
            xpath += xpath.endsWith('//') ? piece.value : `/${piece.value}`;
          }
        }
        return xpath;
      }));
      const ordinal = Math.max(0, allFrames.indexOf(frame));
      if (xpaths.length > 0) output.set(ordinal, new Set(xpaths));
    }));
    return output;
  }
}

export function buildSnapshot(
  dom: DomSnapshotResponse,
  ax: AxResponse | AxResponse[],
  options: {
    url: string;
    title: string;
    maxChars: number;
    selector?: string;
    scopeXpaths?: Map<number, Set<string>>;
    ignoreXpaths?: Map<number, Set<string>>;
    scrollableElementIds?: Set<string>;
    frameUrls?: string[];
  }
): PageSnapshot {
  const strings = dom.strings ?? [];
  const axTrees = Array.isArray(ax) ? ax : [{ ...ax, frameOrdinal: ax.frameOrdinal ?? 0 }];
  const axByElementId = new Map<string, AxNode>();
  for (const tree of axTrees) {
    for (const node of tree.nodes ?? []) {
      if (!node.ignored && node.backendDOMNodeId !== undefined) {
        axByElementId.set(`${tree.frameOrdinal ?? 0}-${node.backendDOMNodeId}`, node);
      }
    }
  }

  const snapshotNodes: SnapshotNode[] = [];
  const elementIdToXpath: Record<string, string> = {};
  const xpathToElementId: Record<string, string> = {};
  const urlMap: Record<string, string> = {};
  const documents = dom.documents ?? [];
  const documentOrdinals = mapDocumentOrdinals(documents, strings, options.frameUrls ?? [options.url]);
  const documentPrefixes = buildDocumentPrefixes(documents, strings);
  const documentHosts = buildDocumentHosts(documents);
  const includedByDocument = new Map<number, Map<number, SnapshotNode>>();
  const excludedDocuments = new Set<number>();
  for (const [documentIndex, document] of documents.entries()) {
    if (excludedDocuments.has(documentIndex)) {
      for (const childDocumentIndex of document.nodes?.contentDocumentIndex?.value ?? []) {
        if (childDocumentIndex >= 0) excludedDocuments.add(childDocumentIndex);
      }
      continue;
    }
    const frameOrdinal = documentOrdinals.get(documentIndex) ?? documentIndex;
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
    for (const [index] of attributesByIndex.entries()) {
      const xpath = absoluteXPath(index, nodes, strings);
      if (xpath && options.scopeXpaths?.get(frameOrdinal)?.has(xpath)) scopeRoots.add(index);
      if (xpath && options.ignoreXpaths?.get(frameOrdinal)?.has(xpath)) ignoreRoots.add(index);
    }
    const contentDocuments = nodes.contentDocumentIndex;
    for (const [position, hostNodeIndex] of (contentDocuments?.index ?? []).entries()) {
      const childDocumentIndex = contentDocuments?.value?.[position];
      if (
        childDocumentIndex !== undefined &&
        childDocumentIndex >= 0 &&
        isWithin(hostNodeIndex, ignoreRoots, nodes.parentIndex)
      ) {
        excludedDocuments.add(childDocumentIndex);
      }
    }
    const descendantTextByIndex = collectDescendantText(nodes, strings, ignoreRoots);
    const includedByIndex = new Map<number, SnapshotNode>();
    includedByDocument.set(documentIndex, includedByIndex);
    if (
      (options.scopeXpaths && !options.scopeXpaths.has(frameOrdinal)) ||
      (options.scopeXpaths?.has(frameOrdinal) && scopeRoots.size === 0)
    ) {
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
        const backendNodeId = nodes.backendNodeId?.[index];
        const axNode = backendNodeId === undefined
          ? undefined
          : axByElementId.get(`${frameOrdinal}-${backendNodeId}`);
        const name = stringValue(axNode?.name) || value;
        if (!name || backendNodeId === undefined || !bounds || bounds[2] <= 0 || bounds[3] <= 0 ||
          isWithinExcludedTag(index, nodes, strings)) continue;
        const localXpath = absoluteXPath(index, nodes, strings);
        const xpath = localXpath
          ? prefixDocumentXPath(documentPrefixes.get(documentIndex), localXpath)
          : undefined;
        const parent = nearestIncludedParent(index, nodes.parentIndex, includedByIndex);
        const elementId = `${frameOrdinal}-${backendNodeId}`;
        const actionParentIndex = nearestElementParent(index, nodes);
        const actionBackendNodeId = actionParentIndex === undefined
          ? backendNodeId
          : nodes.backendNodeId?.[actionParentIndex] ?? backendNodeId;
        const actionableXpath = xpath?.replace(/\/text\(\)(?:\[\d+\])?$/iu, '');
        const identity = {
          frameUrl: documentUrl,
          frameOrdinal,
          backendNodeId: actionBackendNodeId
        };
        const snapshotNode: SnapshotNode = {
          elementId,
          backendNodeId,
          tag: '#text',
          role: stringValue(axNode?.role) || 'StaticText',
          name,
          text: name,
          attributes: {},
          visible: true,
          disabled: false,
          selected: booleanAxProperty(axNode, 'selected'),
          checked: booleanAxProperty(axNode, 'checked'),
          focused: booleanAxProperty(axNode, 'focused'),
          frameUrl: documentUrl,
          bounds,
          locators: actionableXpath
            ? [{ strategy: 'xpath', value: actionableXpath, ...identity }]
            : [],
          xpath,
          parentElementId: parent?.elementId,
          depth: parent ? (parent.depth ?? 0) + 1 : 0
        };
        snapshotNodes.push(snapshotNode);
        includedByIndex.set(index, snapshotNode);
        if (xpath) {
          elementIdToXpath[elementId] = xpath;
          xpathToElementId[`${frameOrdinal}:${xpath}`] = elementId;
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
      const axNode = axByElementId.get(`${frameOrdinal}-${backendNodeId}`);
      const axRole = stringValue(axNode?.role);
      const structural = isStructuralRole(axRole);
      const structuralChildCount = axNode?.childIds?.length ?? 0;
      const role = tag === 'input' && attributes.type?.toLowerCase() === 'file'
        ? 'input, file'
        : tag === 'select' && axRole === 'combobox'
          ? 'select'
          : structural && structuralChildCount > 1
            ? tag
          : axRole;
      const domText = descendantTextByIndex.get(index);
      const explicitName = attributes['aria-label'] || attributes.title;
      const axName = stringValue(axNode?.name);
      const name = explicitName || axName ||
        (!isContainerElement(tag, role) ? domText : undefined);
      const value = isSensitiveInput(tag, attributes)
        ? '[REDACTED]'
        : stringValue(axNode?.value) || attributes.value;
      const text = isContainerElement(tag, role)
        ? name
        : domText || stringAt(strings, nodes.nodeValue?.[index]) || name;
      const bounds = layoutByNode.get(index);
      const visible = Boolean(bounds && bounds[2] > 0 && bounds[3] > 0 && attributes.hidden === undefined);
      const disabled = attributes.disabled !== undefined || axProperty(axNode, 'disabled') === true;
      const selected = booleanAxProperty(axNode, 'selected');
      const checked = booleanAxProperty(axNode, 'checked');
      const focused = booleanAxProperty(axNode, 'focused');
      const scrollable = options.scrollableElementIds?.has(`${frameOrdinal}-${backendNodeId}`) === true || tag === 'html';
      const localXpath = absoluteXPath(index, nodes, strings);
      const xpath = localXpath
        ? prefixDocumentXPath(documentPrefixes.get(documentIndex), localXpath)
        : undefined;
      const testId = attributes['data-testid'] ?? attributes['data-test-id'];
      const locators = buildLocators({
        backendNodeId,
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

      if (!shouldIncludeNode({
        tag,
        role,
        name,
        text,
        visible,
        scrollable,
        locators,
        structural,
        structuralChildCount
      })) {
        continue;
      }

      const elementId = `${frameOrdinal}-${backendNodeId}`;
      const href = stringAxProperty(axNode, 'url') || attributes.href;
      let parent = nearestIncludedParent(
        index,
        nodes.parentIndex,
        includedByIndex
      );
      if (!parent) {
        const host = documentHosts.get(documentIndex);
        parent = host
          ? includedByDocument.get(host.documentIndex)?.get(host.nodeIndex)
          : undefined;
      }
      const snapshotNode: SnapshotNode = {
        elementId,
        backendNodeId,
        tag,
        role,
        name,
        value,
        description: stringValue(axNode?.description),
        text,
        attributes: safeAttributes(attributes),
        visible,
        disabled,
        selected,
        checked,
        focused,
        scrollable,
        frameUrl: documentUrl,
        bounds,
        locators,
        xpath,
        href,
        parentElementId: parent?.elementId,
        depth: parent ? (parent.depth ?? 0) + 1 : 0
      };
      snapshotNodes.push(snapshotNode);
      includedByIndex.set(index, snapshotNode);
      if (xpath) {
        elementIdToXpath[elementId] = xpath;
        xpathToElementId[`${frameOrdinal}:${xpath}`] = elementId;
      }
      if (href) {
        urlMap[elementId] = href;
      }
    }
  }

  applyAxHierarchy(snapshotNodes, axTrees);
  removeRedundantStaticText(snapshotNodes);

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
    nodes: snapshotNodes,
    elementIdToXpath,
    xpathToElementId,
    urlMap
  };
}

async function getDomTreeWithFallback(session: CDPSession): Promise<CdpDomNode> {
  const depths = [-1, 256, 128, 64, 32, 16, 8, 4, 2, 1];
  let lastError: unknown;
  for (const depth of depths) {
    try {
      const response = await session.send('DOM.getDocument', {
        depth,
        pierce: true
      }) as { root: CdpDomNode };
      if (depth !== -1) await hydrateDomTree(session, response.root);
      return response.root;
    } catch (error) {
      lastError = error;
      if (!String(error instanceof Error ? error.message : error).includes('CBOR: stack limit exceeded')) {
        throw error;
      }
    }
  }
  throw lastError;
}

async function hydrateDomTree(session: CDPSession, root: CdpDomNode): Promise<void> {
  const depths = [-1, 64, 32, 16, 8, 4, 2, 1];
  const stack = [root];
  const visited = new Set<number>();
  while (stack.length > 0) {
    const node = stack.pop()!;
    const identity = node.nodeId && node.nodeId > 0 ? node.nodeId : node.backendNodeId;
    if (identity !== undefined && visited.has(identity)) continue;
    if (identity !== undefined) visited.add(identity);
    if ((node.childNodeCount ?? 0) > (node.children?.length ?? 0) && identity !== undefined) {
      for (const depth of depths) {
        try {
          const response = await session.send('DOM.describeNode', {
            ...(node.nodeId && node.nodeId > 0
              ? { nodeId: node.nodeId }
              : { backendNodeId: node.backendNodeId }),
            depth,
            pierce: true
          }) as { node: CdpDomNode };
          node.children = response.node.children ?? node.children;
          node.shadowRoots = response.node.shadowRoots ?? node.shadowRoots;
          node.contentDocument = response.node.contentDocument ?? node.contentDocument;
          node.childNodeCount = response.node.childNodeCount ?? node.childNodeCount;
          break;
        } catch (error) {
          if (!String(error instanceof Error ? error.message : error).includes('CBOR: stack limit exceeded')) {
            throw error;
          }
        }
      }
    }
    stack.push(
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.pseudoElements ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
      ...(node.templateContent ? [node.templateContent] : [])
    );
  }
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

const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'iframe',
  'input',
  'select',
  'textarea',
  'option',
  'summary'
]);

const INTERACTIVE_ROLES = new Set([
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

function shouldIncludeNode(input: {
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  visible: boolean;
  scrollable: boolean;
  locators: LocatorDescriptor[];
  structural: boolean;
  structuralChildCount: number;
}): boolean {
  if (!input.visible) {
    return false;
  }
  if (input.structural) return input.structuralChildCount > 1;
  return (
    input.scrollable ||
    INTERACTIVE_TAGS.has(input.tag) ||
    (input.role ? INTERACTIVE_ROLES.has(input.role) : false) ||
    Boolean(input.name || input.text)
  );
}

function isStructuralRole(role?: string): boolean {
  const normalized = role?.toLowerCase();
  return normalized === 'generic' || normalized === 'none' || normalized === 'inlinetextbox';
}

function buildLocators(input: {
  backendNodeId: number;
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
  const identity = {
    frameUrl,
    frameOrdinal,
    backendNodeId: input.backendNodeId
  };
  const testId = input.attributes['data-testid'] ?? input.attributes['data-test-id'];
  add(input.preferXpath && input.xpath
    ? { strategy: 'xpath', value: input.xpath, ...identity }
    : undefined);
  add(testId ? { strategy: 'testId', value: testId, ...identity } : undefined);
  add(input.role && input.name
    ? { strategy: 'role', value: input.role, name: input.name, ...identity }
    : undefined);
  add(input.attributes['aria-label']
    ? { strategy: 'label', value: input.attributes['aria-label'], ...identity }
    : undefined);
  add(input.attributes.placeholder
    ? { strategy: 'placeholder', value: input.attributes.placeholder, ...identity }
    : undefined);
  add(input.text && input.text.length <= 120
    ? { strategy: 'text', value: input.text, ...identity }
    : undefined);
  add(cssLocator(
    input.tag,
    input.attributes,
    frameUrl,
    frameOrdinal,
    input.backendNodeId
  ));
  add(!input.preferXpath && input.xpath
    ? { strategy: 'xpath', value: input.xpath, ...identity }
    : undefined);
  return output;
}

function cssLocator(
  tag: string,
  attributes: Record<string, string>,
  frameUrl?: string,
  frameOrdinal?: number,
  backendNodeId?: number
): LocatorDescriptor | undefined {
  if (attributes.id) {
    return {
      strategy: 'css',
      value: `#${cssEscape(attributes.id)}`,
      frameUrl,
      frameOrdinal,
      backendNodeId
    };
  }
  if (attributes.name) {
    return {
      strategy: 'css',
      value: `${tag}[name=${JSON.stringify(attributes.name)}]`,
      frameUrl,
      frameOrdinal,
      backendNodeId
    };
  }
  if (attributes.type && ['input', 'button'].includes(tag)) {
    return {
      strategy: 'css',
      value: `${tag}[type=${JSON.stringify(attributes.type)}]`,
      frameUrl,
      frameOrdinal,
      backendNodeId
    };
  }
  return undefined;
}

function absoluteXPath(
  index: number,
  nodes: NonNullable<DomSnapshotDocument['nodes']>,
  strings: string[]
): string | undefined {
  const parts: Array<{ segment?: string; shadowBoundary?: true }> = [];
  let current = index;
  while (current >= 0) {
    const nodeType = nodes.nodeType?.[current];
    if (nodeType === 3 || nodeType === 8) {
      const parent = nodes.parentIndex?.[current] ?? -1;
      let position = 1;
      if (parent >= 0) {
        for (let sibling = 0; sibling < current; sibling += 1) {
          if (nodes.parentIndex?.[sibling] === parent && nodes.nodeType?.[sibling] === nodeType) {
            position += 1;
          }
        }
      }
      parts.push({ segment: `${nodeType === 3 ? 'text()' : 'comment()'}[${position}]` });
    } else if (nodeType === 1) {
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
      parts.push({ segment: `${tag}[${position}]` });
      if (
        rareValue(nodes.shadowRootType, current) !== undefined &&
        (parent < 0 || rareValue(nodes.shadowRootType, parent) === undefined)
      ) {
        parts.push({ shadowBoundary: true });
      }
    } else if (
      nodes.nodeType?.[current] === 11 &&
      rareValue(nodes.shadowRootType, current) !== undefined
    ) {
      parts.push({ shadowBoundary: true });
    }
    current = nodes.parentIndex?.[current] ?? -1;
  }
  parts.reverse();
  let xpath = '';
  for (const part of parts) {
    if (part.shadowBoundary) {
      xpath = xpath.endsWith('/') ? `${xpath}/` : `${xpath}//`;
      continue;
    }
    if (!part.segment) {
      continue;
    }
    xpath += xpath.endsWith('//') ? part.segment : `/${part.segment}`;
  }
  return xpath || undefined;
}

function buildDocumentPrefixes(
  documents: DomSnapshotDocument[],
  strings: string[]
): Map<number, string> {
  const prefixes = new Map<number, string>([[0, '']]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parentDocumentIndex, document] of documents.entries()) {
      const parentPrefix = prefixes.get(parentDocumentIndex);
      if (parentPrefix === undefined || !document.nodes) {
        continue;
      }
      const contentDocuments = document.nodes.contentDocumentIndex;
      for (const [position, hostNodeIndex] of (contentDocuments?.index ?? []).entries()) {
        const childDocumentIndex = contentDocuments?.value?.[position];
        if (
          childDocumentIndex === undefined ||
          childDocumentIndex < 0 ||
          prefixes.has(childDocumentIndex)
        ) {
          continue;
        }
        const hostXpath = absoluteXPath(hostNodeIndex, document.nodes, strings);
        if (!hostXpath) {
          continue;
        }
        prefixes.set(
          childDocumentIndex,
          prefixDocumentXPath(parentPrefix, hostXpath)
        );
        changed = true;
      }
    }
  }
  return prefixes;
}

function buildDocumentHosts(
  documents: DomSnapshotDocument[]
): Map<number, { documentIndex: number; nodeIndex: number }> {
  const hosts = new Map<number, { documentIndex: number; nodeIndex: number }>();
  for (const [documentIndex, document] of documents.entries()) {
    const contentDocuments = document.nodes?.contentDocumentIndex;
    for (const [position, nodeIndex] of (contentDocuments?.index ?? []).entries()) {
      const childDocumentIndex = contentDocuments?.value?.[position];
      if (childDocumentIndex !== undefined && childDocumentIndex >= 0) {
        hosts.set(childDocumentIndex, { documentIndex, nodeIndex });
      }
    }
  }
  return hosts;
}

function nearestIncludedParent(
  index: number,
  parents: number[] | undefined,
  included: Map<number, SnapshotNode>
): SnapshotNode | undefined {
  let current = parents?.[index] ?? -1;
  while (current >= 0) {
    const parent = included.get(current);
    if (parent) {
      return parent;
    }
    current = parents?.[current] ?? -1;
  }
  return undefined;
}

function nearestElementParent(
  index: number,
  nodes: NonNullable<DomSnapshotDocument['nodes']>
): number | undefined {
  let current = nodes.parentIndex?.[index] ?? -1;
  while (current >= 0) {
    if (nodes.nodeType?.[current] === 1) return current;
    current = nodes.parentIndex?.[current] ?? -1;
  }
  return undefined;
}

function prefixDocumentXPath(prefix: string | undefined, localXpath: string): string {
  if (!prefix) {
    return localXpath;
  }
  return `${prefix.replace(/\/$/u, '')}/${localXpath.replace(/^\//u, '')}`;
}

function rareValue(
  data: { index?: number[]; value?: number[] } | undefined,
  nodeIndex: number
): number | undefined {
  const position = data?.index?.indexOf(nodeIndex) ?? -1;
  return position >= 0 ? data?.value?.[position] : undefined;
}

function serializeSnapshot(
  nodes: SnapshotNode[],
  options: { maxChars: number }
): string {
  const lines = nodes.map((node) => {
      const indent = '  '.repeat(node.depth ?? 0);
      const displayedRole = node.scrollable
        ? `scrollable, ${node.tag}`
        : node.role ?? node.tag;
      const fields = [
        `${indent}[${node.elementId}]`,
        `${displayedRole}${node.name ? `: ${cleanAxText(node.name)}` : ''}`,
        node.selected ? '[selected]' : undefined,
        node.checked ? '[checked]' : undefined
      ];
      return fields.filter(Boolean).join(' ');
    });
  const result = lines.join('\n');
  return result.length <= options.maxChars
    ? result
    : `${result.slice(0, options.maxChars)}\n[SNAPSHOT_TRUNCATED]`;
}

function applyAxHierarchy(nodes: SnapshotNode[], axTrees: AxResponse[]): void {
  const snapshotByElementId = new Map(nodes.map((node) => [node.elementId, node]));
  const orderByElementId = new Map<string, number>();
  for (const tree of axTrees) {
    const ordinal = tree.frameOrdinal ?? 0;
    const axNodes = tree.nodes ?? [];
    const axById = new Map(
      axNodes.flatMap((node) => node.nodeId ? [[node.nodeId, node] as const] : [])
    );
    for (const [index, axNode] of axNodes.entries()) {
      if (axNode.backendDOMNodeId !== undefined) {
        orderByElementId.set(`${ordinal}-${axNode.backendDOMNodeId}`, index);
      }
      if (axNode.ignored || axNode.backendDOMNodeId === undefined) continue;
      const node = snapshotByElementId.get(`${ordinal}-${axNode.backendDOMNodeId}`);
      if (!node) continue;
      let parentId = axNode.parentId;
      while (parentId) {
        const parentAx = axById.get(parentId);
        const parent = parentAx?.backendDOMNodeId === undefined
          ? undefined
          : snapshotByElementId.get(`${ordinal}-${parentAx.backendDOMNodeId}`);
        if (parent && parent !== node) {
          node.parentElementId = parent.elementId;
          break;
        }
        parentId = parentAx?.parentId;
      }
    }
  }

  const byElementId = new Map(nodes.map((node) => [node.elementId, node]));
  const depthFor = (node: SnapshotNode, seen = new Set<string>()): number => {
    if (!node.parentElementId || seen.has(node.elementId)) return 0;
    seen.add(node.elementId);
    const parent = byElementId.get(node.parentElementId);
    return parent ? depthFor(parent, seen) + 1 : 0;
  };
  for (const node of nodes) {
    node.depth = depthFor(node);
  }

  const originalOrder = new Map(nodes.map((node, index) => [node.elementId, index]));
  const compare = (left: SnapshotNode, right: SnapshotNode): number => {
    const leftOrdinal = left.locators[0]?.frameOrdinal ?? 0;
    const rightOrdinal = right.locators[0]?.frameOrdinal ?? 0;
    return leftOrdinal - rightOrdinal ||
      (orderByElementId.get(left.elementId) ?? Number.MAX_SAFE_INTEGER) -
      (orderByElementId.get(right.elementId) ?? Number.MAX_SAFE_INTEGER) ||
      (originalOrder.get(left.elementId) ?? 0) - (originalOrder.get(right.elementId) ?? 0);
  };
  const children = new Map<string, SnapshotNode[]>();
  const roots: SnapshotNode[] = [];
  for (const node of nodes) {
    if (node.parentElementId && byElementId.has(node.parentElementId)) {
      const siblings = children.get(node.parentElementId) ?? [];
      siblings.push(node);
      children.set(node.parentElementId, siblings);
    } else {
      roots.push(node);
    }
  }
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);

  const ordered: SnapshotNode[] = [];
  const visited = new Set<string>();
  const visit = (node: SnapshotNode): void => {
    if (visited.has(node.elementId)) return;
    visited.add(node.elementId);
    ordered.push(node);
    for (const child of children.get(node.elementId) ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  for (const node of [...nodes].sort(compare)) visit(node);
  nodes.splice(0, nodes.length, ...ordered);
}

function removeRedundantStaticText(nodes: SnapshotNode[]): void {
  const children = new Map<string, SnapshotNode[]>();
  for (const node of nodes) {
    if (!node.parentElementId) continue;
    const values = children.get(node.parentElementId) ?? [];
    values.push(node);
    children.set(node.parentElementId, values);
  }
  const remove = new Set<string>();
  for (const parent of nodes) {
    if (!parent.name) continue;
    const staticChildren = (children.get(parent.elementId) ?? []).filter((child) =>
      child.role?.toLowerCase() === 'statictext' && Boolean(child.name)
    );
    const combined = staticChildren.map((child) => normalizeSpaces(child.name ?? '').trim()).join('');
    if (combined && combined === normalizeSpaces(parent.name).trim()) {
      for (const child of staticChildren) remove.add(child.elementId);
    }
  }
  if (remove.size > 0) {
    nodes.splice(0, nodes.length, ...nodes.filter((node) => !remove.has(node.elementId)));
  }
}

function flattenFrameTree(root: CdpFrameTree): Array<{ id: string; url?: string }> {
  const frames: Array<{ id: string; url?: string }> = [];
  const visit = (node: CdpFrameTree): void => {
    frames.push({ id: node.frame.id, url: node.frame.url });
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(root);
  return frames;
}

function mapDocumentOrdinals(
  documents: DomSnapshotDocument[],
  strings: string[],
  frameUrls: string[]
): Map<number, number> {
  const ordinals = new Map<number, number>();
  const unused = new Set(frameUrls.map((_, ordinal) => ordinal));
  for (const [documentIndex, document] of documents.entries()) {
    const documentUrl = stringAt(strings, document.documentURL);
    let ordinal = documentIndex === 0 && unused.has(0) ? 0 : undefined;
    if (ordinal === undefined) {
      ordinal = [...unused].find((candidate) =>
        sameDocumentUrl(frameUrls[candidate] ?? '', documentUrl)
      );
    }
    if (ordinal === undefined && unused.has(documentIndex)) ordinal = documentIndex;
    if (ordinal === undefined) ordinal = documentIndex;
    ordinals.set(documentIndex, ordinal);
    unused.delete(ordinal);
  }
  return ordinals;
}

function sameDocumentUrl(left: string, right: string): boolean {
  if (left === right) return true;
  try {
    const a = new URL(left);
    const b = new URL(right);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return left.replace(/#.*$/u, '') === right.replace(/#.*$/u, '');
  }
}

function stripCssPrefix(selector: string): string {
  return selector.replace(/^css=/iu, '');
}

function normalizePlaywrightSelector(selector: string): string {
  if (/^xpath=/iu.test(selector) || /^text=/iu.test(selector)) return selector;
  if (selector.startsWith('/') || selector.startsWith('(')) return `xpath=${selector}`;
  return stripCssPrefix(selector);
}

function cleanAxText(input: string): string {
  let output = '';
  let previousSpace = false;
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 0xe000 && code <= 0xf8ff) continue;
    if (code === 0x00a0 || code === 0x202f || code === 0x2007 || code === 0xfeff) {
      if (!previousSpace) output += ' ';
      previousSpace = true;
      continue;
    }
    output += character;
    previousSpace = character === ' ';
  }
  return output.trim();
}

function normalizeSpaces(input: string): string {
  return input.replace(/\s+/gu, ' ');
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

function stringAxProperty(node: AxNode | undefined, name: string): string | undefined {
  const value = axProperty(node, name);
  return typeof value === 'string' ? value : undefined;
}

function booleanAxProperty(node: AxNode | undefined, name: string): boolean | undefined {
  const value = axProperty(node, name);
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === 'true') return true;
  if (value === 0 || value === 'false') return false;
  return undefined;
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
