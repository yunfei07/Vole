import type { z } from 'zod';

export type AiActionMethod =
  | 'click'
  | 'fill'
  | 'selectOption'
  | 'setInputFiles'
  | 'press'
  | 'hover'
  | 'doubleClick';

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
};

export type PageSnapshot = {
  url: string;
  title: string;
  fingerprint: string;
  text: string;
  nodes: SnapshotNode[];
};

export type AiActInput = {
  instruction: string;
  action?: AiActionMethod;
  target?: string;
  value?: string;
  filePath?: string;
  variables?: Record<string, string>;
  timeoutMs?: number;
};

export type AiActResult = {
  success: true;
  action: AiActionMethod;
  locator: LocatorDescriptor;
  fromCache: boolean;
  selfHealed: boolean;
};

export type AiObserveOptions = {
  timeoutMs?: number;
  selector?: string;
  variables?: Record<string, string>;
};

export type AiActionCandidate = {
  elementId: string;
  description: string;
  method: AiActionMethod;
  arguments: string[];
  confidence: number;
  locator: LocatorDescriptor;
};

export type AiExtractOptions = {
  timeoutMs?: number;
  selector?: string;
  context?: string;
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
};

export type AiAgentHistoryItem = {
  step: number;
  tool: string;
  input: unknown;
  output: unknown;
};

export type AiAgentResult = {
  success: true;
  message: string;
  steps: number;
  history: AiAgentHistoryItem[];
};

export type ExtractSchema<T> = z.ZodType<T>;

export type RuntimeModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

