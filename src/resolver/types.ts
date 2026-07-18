import type { TestPlan, TestStep } from '../cases/test-plan-schema.js';

export type ResolveStatus = 'resolved' | 'ai_fallback' | 'ambiguous' | 'unresolved';
export type ExecutionStrategy = 'static' | 'ai-act' | 'ai-agent' | 'ai-assert';

export type ResolveCandidate = {
  id: string;
  type: 'page' | 'element' | 'business_action';
  semanticName: string;
  pageName?: string;
  locator?: string;
  confidence: number;
  evidence: string;
};

export type ResolveResult = {
  status: ResolveStatus;
  execution: ExecutionStrategy;
  stepId: string;
  target: string;
  matched?: ResolveCandidate;
  candidates?: ResolveCandidate[];
  reason?: string;
};

export type ResolvedStep = {
  step: TestStep;
  resolution: ResolveResult;
};

export type ResolvedPlan = {
  name: string;
  role?: string;
  preconditions?: string[];
  status: 'resolved' | 'partial' | 'unresolved';
  steps: ResolvedStep[];
  summary: {
    total: number;
    resolved: number;
    aiFallback: number;
    ambiguous: number;
    unresolved: number;
  };
  sourcePlan: TestPlan;
};
