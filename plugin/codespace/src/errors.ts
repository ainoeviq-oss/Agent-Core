export class CodespaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CodespaceError';
  }
}

export function errorPayload(error: unknown) {
  if (error instanceof CodespaceError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
