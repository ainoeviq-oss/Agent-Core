import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry-service.js';
import { FileSystemService } from './filesystem.js';
import { ProcessManager } from './process-manager.js';
import { SearchService } from './search.js';
import { WorkspacePolicy } from './workspace.js';

export interface RuntimeServices {
  workspace: WorkspacePolicy;
  filesystem: FileSystemService;
  search: SearchService;
  processes: ProcessManager;
  capabilities: CapabilityRegistry;
}

export function createRuntimeServices(
  allowedRoots: string[],
  capabilityDir = path.join(allowedRoots[0] ?? process.cwd(), 'capabilities'),
): RuntimeServices {
  const workspace = new WorkspacePolicy(allowedRoots);
  return {
    workspace,
    filesystem: new FileSystemService(workspace),
    search: new SearchService(workspace),
    processes: new ProcessManager(workspace),
    capabilities: CapabilityRegistry.open(capabilityDir),
  };
}
