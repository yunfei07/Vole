import type { ModelMessage, PrepareStepFunction, ToolSet } from 'ai';
import type { z } from 'zod';

export type AiActionMethod =
  | 'click'
  | 'fill'
  | 'type'
  | 'selectOption'
  | 'selectOptionFromDropdown'
  | 'setInputFiles'
  | 'press'
  | 'hover'
  | 'doubleClick'
  | 'scrollTo'
  | 'nextChunk'
  | 'prevChunk'
  | 'dragAndDrop';

export type LocatorDescriptor = {
  strategy: 'testId' | 'role' | 'label' | 'placeholder' | 'text' | 'css' | 'xpath';
  value: string;
  name?: string;
  frameUrl?: string;
};

export type SnapshotNode = {
  elementId: string;
  backendNodeId: number;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  text?: string;
  attributes: Record<string, string>;
  visible: boolean;
  disabled: boolean;
  frameUrl?: string;
  bounds?: [number, number, number, number];
  locators: LocatorDescriptor[];
  xpath?: string;
  href?: string;
};

export type PageSnapshot = {
  url: string;
  title: string;
  fingerprint: string;
  text: string;
  nodes: SnapshotNode[];
  elementIdToXpath: Record<string, string>;
  xpathToElementId: Record<string, string>;
  urlMap: Record<string, string>;
};

export type AiAction = {
  selector: string;
  description: string;
  method?: AiActionMethod;
  arguments?: string[];
};

export type AiActInput = {
  instruction: string;
  action?: AiActionMethod;
  target?: string;
  value?: string;
  filePath?: string;
  variables?: Record<string, string>;
  timeoutMs?: number;
  model?: string;
};

export type AiActOptions = {
  model?: string;
  variables?: Record<string, string>;
  timeoutMs?: number;
  cache?: boolean;
};

export type AiActResult = {
  success: boolean;
  message: string;
  actionDescription: string;
  actions: AiAction[];
  action?: AiActionMethod;
  locator?: LocatorDescriptor;
  fromCache: boolean;
  selfHealed: boolean;
  cacheStatus: 'HIT' | 'MISS';
  usage?: RuntimeModelUsage;
};

export type AiObserveOptions = {
  timeoutMs?: number;
  selector?: string;
  ignoreSelectors?: string[];
  variables?: Record<string, string>;
  model?: string;
  cache?: boolean;
};

export type AiActionCandidate = AiAction & {
  elementId: string;
  method: AiActionMethod;
  arguments: string[];
  confidence: number;
  locator: LocatorDescriptor;
};

export type AiExtractOptions = {
  timeoutMs?: number;
  selector?: string;
  ignoreSelectors?: string[];
  context?: string;
  screenshot?: boolean;
  model?: string;
};

export type AiAssertKind =
  | 'visible'
  | 'hidden'
  | 'text'
  | 'containsText'
  | 'enabled'
  | 'disabled'
  | 'semantic';

export type AiAssertInput = {
  instruction: string;
  kind: AiAssertKind;
  target?: string;
  expected?: string;
  variables?: Record<string, string>;
  timeoutMs?: number;
};

export type AiAssertResult = {
  passed: true;
  actual: unknown;
  evidence: string[];
  reason: string;
};

export type AiAgentInput = {
  instruction: string;
  variables?: Record<string, string>;
  maxSteps?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  messages?: ModelMessage[];
  output?: z.ZodType<Record<string, unknown>>;
  callbacks?: AiAgentCallbacks;
};

export type AiAgentHistoryItem = {
  step: number;
  tool: string;
  input: unknown;
  output: unknown;
};

export type AiAgentResult = {
  success: boolean;
  message: string;
  steps: number;
  history: AiAgentHistoryItem[];
  actions: AiAgentHistoryItem[];
  completed: boolean;
  usage?: RuntimeModelUsage & { inferenceTimeMs?: number };
  messages?: ModelMessage[];
  output?: Record<string, unknown>;
};

export type AiAgentCallbacks = {
  prepareStep?: PrepareStepFunction<ToolSet>;
  onStepFinish?: (item: AiAgentHistoryItem) => void | Promise<void>;
  onEvidence?: (event: {
    type: 'screenshot' | 'action' | 'observation' | 'final';
    step?: number;
    data: unknown;
  }) => void | Promise<void>;
  onChunk?: (chunk: string) => void | Promise<void>;
  onFinish?: (result: AiAgentResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
};

export type AiAgentConfig = {
  mode?: 'dom';
  model?: string;
  executionModel?: string;
  stream?: boolean;
  systemPrompt?: string;
  tools?: ToolSet;
};

export type AiAgentExecuteOptions = AiAgentInput;

export type AiAgentInstance = {
  execute(input: string | AiAgentExecuteOptions): Promise<AiAgentResult>;
};

export type AiStreamingAgentInstance = {
  execute(input: string | AiAgentExecuteOptions): Promise<{
    textStream: AsyncIterable<string>;
    result: Promise<AiAgentResult>;
  }>;
};

export type ExtractSchema<T> = z.ZodType<T>;

export type RuntimeModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
};
