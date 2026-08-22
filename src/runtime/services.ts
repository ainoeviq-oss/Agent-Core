import { FileSystemService } from './filesystem.js';
import { ProcessManager } from './process-manager.js';
import { SearchService } from './search.js';
import { WorkspacePolicy } from './workspace.js';

export interface RuntimeServices {
  workspace: WorkspacePolicy;
  filesystem: FileSystemService;
  search: SearchService;
  processes: ProcessManager;
}

export function createRuntimeServices(allowedRoots: string[]): RuntimeServices {
  const workspace = new WorkspacePolicy(allowedRoots);
  return {
    workspace,
    filesystem: new FileSystemService(workspace),
    search: new SearchService(workspace),
    processes: new ProcessManager(workspace),
  };
}
