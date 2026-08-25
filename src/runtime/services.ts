import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry-service.js';
import { CapabilityRouter } from '../capabilities/router.js';
import { loadConfig, type MemoryConfig } from '../config.js';
import type { RoutingAuditLogger } from '../logging/audit-log.js';
import { MemoryService } from '../memory/service.js';
import { FileSystemService } from './filesystem.js';
import { ProcessManager } from './process-manager.js';
import { RouteContextStore } from './route-context-store.js';
import { SearchService } from './search.js';
import { WorkspacePolicy } from './workspace.js';

export interface RuntimeServices {
  workspace: WorkspacePolicy;
  filesystem: FileSystemService;
  search: SearchService;
  processes: ProcessManager;
  capabilities: CapabilityRegistry;
  router: CapabilityRouter;
  routes: RouteContextStore;
  memory: MemoryService;
}

export function createRuntimeServices(
  allowedRoots: string[],
  capabilityDir = path.join(allowedRoots[0] ?? process.cwd(), 'capabilities'),
  routingAuditLogger?: RoutingAuditLogger,
  memoryConfig?: MemoryConfig,
): RuntimeServices {
  const workspace = new WorkspacePolicy(allowedRoots);
  const capabilities = CapabilityRegistry.open(capabilityDir);
  const resolvedMemoryConfig = memoryConfig ?? loadConfig({}, allowedRoots[0] ?? process.cwd()).memory;
  return {
    workspace,
    filesystem: new FileSystemService(workspace),
    search: new SearchService(workspace),
    processes: new ProcessManager(workspace),
    capabilities,
    router: new CapabilityRouter(capabilities),
    routes: new RouteContextStore(
      routingAuditLogger ? { auditLogger: routingAuditLogger } : {},
    ),
    memory: new MemoryService(resolvedMemoryConfig),
  };
}
