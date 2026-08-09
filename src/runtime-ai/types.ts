import type {
  ModelMessage,
  PrepareStepFunction,
  StepResult,
  StreamTextResult,
  ToolSet
} from 'ai';
import type { z } from 'zod';

type RuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | RuntimeJsonValue[]
  | { [key: string]: RuntimeJsonValue };

export type RuntimeProviderOptions = Record<string, Record<string, RuntimeJsonValue>>;

export type AiVariableValue =
  | string
  | number
  | boolean
  | { value: string | number | boolean; description?: string };

export type AiVariables = Record<string, AiVariableValue>;

/**
 * Every action method the executor can perform. This tuple is the single
 * source of truth: the AiActionMethod union, the executor's SUPPORTED_ACTIONS
 * set, and any per-method dispatch all derive from it.
 *
 * The model-facing act/observe schema only exposes a subset (the "inference"
 * methods declared in runtime.ts); the remaining entries are reached via
 * deterministic AiAction input (e.g. a caller-supplied setInputFiles).
 */
export const ACTION_METHODS = [
  'click',
  'tap',
  'fill',
  'type',
  'selectOption',
  'selectOptionFromDropdown',
  'setInputFiles',
  'press',
  'hover',
  'doubleClick',
  'scrollIntoView',
  'scrollByPixelOffset',
  'scroll',
  'scrollTo',
  'mouse.wheel',
  'nextChunk',
  'prevChunk',
  'dragAndDrop'
] as const;

export type AiActionMethod = (typeof ACTION_METHODS)[number];

export type LocatorDescriptor = {
  strategy: 'testId' | 'role' | 'label' | 'placeholder' | 'text' | 'css' | 'xpath';
  value: string;
  name?: string;
  frameUrl?: string;
  frameOrdinal?: number;
  backendNodeId?: number;
};

export type SnapshotNode = {
  elementId: string;
  backendNodeId: number;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  text?: string;
  attributes: Record<string, string>;
  visible: boolean;
  disabled: boolean;
  selected?: boolean;
  checked?: boolean;
  focused?: boolean;
  scrollable?: boolean;
  frameUrl?: string;
  bounds?: [number, number, number, number];
  locators: LocatorDescriptor[];
  xpath?: string;
  href?: string;
  parentElementId?: string;
  depth?: number;
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
  method?: string;
  arguments?: string[];
  locator?: LocatorDescriptor;
};

export type AiActInput = {
  instruction: string;
  action?: AiActionMethod;
  target?: string;
  value?: string;
  filePath?: string;
  variables?: AiVariables;
  timeoutMs?: number;
  model?: string;
  cache?: boolean;
  abortSignal?: AbortSignal;
  providerOptions?: RuntimeProviderOptions;
};

export type AiActOptions = {
  model?: string;
  variables?: AiVariables;
  timeoutMs?: number;
  cache?: boolean;
  abortSignal?: AbortSignal;
  providerOptions?: RuntimeProviderOptions;
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
  variables?: AiVariables;
  model?: string;
  cache?: boolean;
  abortSignal?: AbortSignal;
  providerOptions?: RuntimeProviderOptions;
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
  abortSignal?: AbortSignal;
  providerOptions?: RuntimeProviderOptions;
  verifyCompleteness?: boolean;
  refineOnIncomplete?: boolean;
};

export type AiExtractCompleteness = {
  completed: boolean;
  missing: string[];
  refined: boolean;
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
  variables?: AiVariables;
  timeoutMs?: number;
  model?: string;
  abortSignal?: AbortSignal;
  providerOptions?: RuntimeProviderOptions;
};

export type AiAssertResult = {
  passed: true;
  actual: unknown;
  evidence: string[];
  reason: string;
};

export type AiAgentInput = {
  instruction: string;
  variables?: AiVariables;
  maxSteps?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  messages?: ModelMessage[];
  output?: z.ZodType<Record<string, unknown>>;
  callbacks?: AiAgentCallbacks;
  providerOptions?: RuntimeProviderOptions;
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
  cacheStatus?: 'HIT' | 'MISS';
  selfHealed?: boolean;
};

export type AiAgentCallbacks = {
  prepareStep?: PrepareStepFunction<ToolSet>;
  onStepFinish?: (event: StepResult<ToolSet, Record<string, unknown>>) => void | Promise<void>;
  onToolFinish?: (item: AiAgentHistoryItem) => void | Promise<void>;
  onEvidence?: (event: {
    type: 'screenshot' | 'action' | 'observation' | 'step_finished' | 'final';
    step?: number;
    data: unknown;
  }) => void | Promise<void>;
  onChunk?: (chunk: string) => void | Promise<void>;
  onFinish?: (result: AiAgentResult) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
  onAbort?: () => void | Promise<void>;
};

export type ToolKind = 'verify' | 'mutate' | 'neutral';

export type AiAgentConfig = {
  mode?: 'dom';
  model?: string;
  executionModel?: string;
  stream?: boolean;
  systemPrompt?: string;
  tools?: ToolSet;
  excludeTools?: string[];
  toolMeta?: Record<string, ToolKind>;
};

export type AiAgentExecuteOptions = AiAgentInput;

export type AiAgentInstance = {
  execute(input: string | AiAgentExecuteOptions): Promise<AiAgentResult>;
};

export type AiStreamingAgentInstance = {
  execute(input: string | AiAgentExecuteOptions): Promise<
    StreamTextResult<ToolSet, Record<string, unknown>, never> & {
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
