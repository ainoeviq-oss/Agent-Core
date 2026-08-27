export const ErrorCode = {
  SOURCE_INVALID_PPTX: 'SOURCE_INVALID_PPTX',
  SOURCE_ZIP_BOMB_RISK: 'SOURCE_ZIP_BOMB_RISK',
  SOURCE_UNSUPPORTED_ENCRYPTION: 'SOURCE_UNSUPPORTED_ENCRYPTION',
  SOURCE_UNSUPPORTED_EXTENSION: 'SOURCE_UNSUPPORTED_EXTENSION',
  SOURCE_PATH_TRAVERSAL: 'SOURCE_PATH_TRAVERSAL',
  GOOGLE_AUTH_REQUIRED: 'GOOGLE_AUTH_REQUIRED',
  GOOGLE_IMPORT_UNAVAILABLE: 'GOOGLE_IMPORT_UNAVAILABLE',
  GOOGLE_UPLOAD_FAILED: 'GOOGLE_UPLOAD_FAILED',
  GOOGLE_TARGET_NOT_NATIVE: 'GOOGLE_TARGET_NOT_NATIVE',
  GOOGLE_SLIDES_GET_FAILED: 'GOOGLE_SLIDES_GET_FAILED',
  GOOGLE_REPAIR_REJECTED: 'GOOGLE_REPAIR_REJECTED',
  KEYNOTE_WORKER_UNAVAILABLE: 'KEYNOTE_WORKER_UNAVAILABLE',
  KEYNOTE_NOT_INSTALLED: 'KEYNOTE_NOT_INSTALLED',
  KEYNOTE_AUTOMATION_PERMISSION_DENIED: 'KEYNOTE_AUTOMATION_PERMISSION_DENIED',
  KEYNOTE_OPEN_FAILED: 'KEYNOTE_OPEN_FAILED',
  KEYNOTE_SAVE_FAILED: 'KEYNOTE_SAVE_FAILED',
  KEYNOTE_OUTPUT_MISSING: 'KEYNOTE_OUTPUT_MISSING',
  FIDELITY_RENDER_FAILED: 'FIDELITY_RENDER_FAILED',
  FIDELITY_TARGET_UNVERIFIABLE: 'FIDELITY_TARGET_UNVERIFIABLE',
  JOB_TIMEOUT: 'JOB_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class BridgeError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export function serializeError(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) {
    return { code: ErrorCode.INTERNAL_ERROR, message: error.message };
  }
  return { code: ErrorCode.INTERNAL_ERROR, message: String(error) };
}
