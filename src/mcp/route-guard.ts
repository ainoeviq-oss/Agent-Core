import type { VerifiedKey } from '../auth/key-types.js';
import { AgentCoreRouteError } from '../runtime/route-context-store.js';
import type { RuntimeServices } from '../runtime/services.js';

export function validateOperationalRoute(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId: string,
  toolName: string,
): void {
  runtime.routes.validate(routeContextId, key.id, toolName);
}

export function routeErrorResult(error: unknown) {
  if (!(error instanceof AgentCoreRouteError)) return null;
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: { code: error.code, message: error.message },
      }, null, 2),
    }],
    isError: true as const,
  };
}
