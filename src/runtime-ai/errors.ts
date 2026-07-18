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

