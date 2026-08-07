export type AiRuntimeErrorCode =
  | 'AI_RUNTIME_DISABLED'
  | 'AI_MODEL_REQUEST_FAILED'
  | 'AI_MODEL_INVALID_RESPONSE'
  | 'AI_MODEL_CAPABILITY_UNSUPPORTED'
  | 'AI_SNAPSHOT_FAILED'
  | 'AI_ACT_FAILED'
  | 'AI_ASSERT_FAILED'
  | 'AI_AGENT_FAILED'
  | 'AI_RUNTIME_TIMEOUT';

export class AiRuntimeError extends Error {
  constructor(
    public readonly code: AiRuntimeErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(`${code}: ${message}`);
    this.name = 'AiRuntimeError';
  }
}

export function runtimeError(code: AiRuntimeErrorCode, message: string, details?: unknown): AiRuntimeError {
  return new AiRuntimeError(code, message, details);
}

/**
 * Raised when a CDP backend node id cannot be resolved to a remote object.
 * Carries the AI_ACT_FAILED code so callers can treat it as a recoverable
 * "fall back to the Playwright locator path" signal via instanceof.
 */
export class BackendResolutionError extends AiRuntimeError {
  constructor(message: string, details?: unknown) {
    super('AI_ACT_FAILED', message, details);
    this.name = 'BackendResolutionError';
  }
}

/** True for abort/timeout-shaped errors regardless of the originating layer. */
export function isCancellation(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === 'AbortError' || /abort|timeout/iu.test(error.message));
}

