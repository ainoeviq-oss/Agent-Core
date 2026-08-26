import type { VerifiedKey } from '../auth/key-types.js';
import { AgentCoreRouteError, type RouteContext } from '../runtime/route-context-store.js';
import type { RuntimeServices } from '../runtime/services.js';
import { WorkspaceProjectError } from '../runtime/workspace.js';

export interface ResolvedRouteProject {
  route: RouteContext;
  projectId: string;
}

export function resolvedRouteProject(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId: string,
): ResolvedRouteProject {
  const route = runtime.routes.getOwned(routeContextId, key.id);
  const projectId = route.projectId ?? runtime.workspace.resolveProjectRoot();
  return { route, projectId };
}

export function resolvedProjectScope(
  runtime: RuntimeServices,
  key: VerifiedKey,
  routeContextId?: string,
): { principalId: string; projectId: string } {
  if (routeContextId) {
    const { projectId } = resolvedRouteProject(runtime, key, routeContextId);
    return { principalId: key.id, projectId };
  }
  return { principalId: key.id, projectId: runtime.workspace.resolveProjectRoot() };
}

function projectMismatch(error: unknown, projectId: string, target: string): never {
  if (error instanceof WorkspaceProjectError && error.code === 'WORKSPACE_PROJECT_MISMATCH') {
    throw new AgentCoreRouteError(
      'ROUTE_PROJECT_MISMATCH',
      `Target is outside the routed project: ${target}`,
      { projectId, target },
    );
  }
  throw error;
}

export async function resolveRouteExistingPath(
  runtime: RuntimeServices,
  route: RouteContext,
  target: string,
): Promise<string> {
  const projectId = route.projectId ?? runtime.workspace.resolveProjectRoot();
  try {
    return await runtime.workspace.resolveExistingInProject(projectId, target);
  } catch (error) {
    return projectMismatch(error, projectId, target);
  }
}

export async function resolveRouteTargetPath(
  runtime: RuntimeServices,
  route: RouteContext,
  target: string,
): Promise<string> {
  const projectId = route.projectId ?? runtime.workspace.resolveProjectRoot();
  try {
    return await runtime.workspace.resolveTargetInProject(projectId, target);
  } catch (error) {
    return projectMismatch(error, projectId, target);
  }
}
