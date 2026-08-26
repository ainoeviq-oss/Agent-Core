import path from 'node:path';
import { CapabilityRegistry } from '../capabilities/registry-service.js';
import { CapabilityRouter } from '../capabilities/router.js';
import { loadConfig, type ExecutionConfig, type GitHubConfig, type MemoryConfig } from '../config.js';
import { ExecutionLogStore } from '../execution/log-store.js';
import { ExecutionMemoryBridge } from '../execution/memory-bridge.js';
import { ExecutionMemoryPreSearch } from '../execution/memory-search.js';
import { ExecutionService } from '../execution/service.js';
import { ExecutionStore } from '../execution/store.js';
import { GitHubService, type GitHubServiceDependencies } from '../github/service.js';
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
  execution: ExecutionService;
  github: GitHubService;
}

export function createRuntimeServices(
  allowedRoots: string[],
  capabilityDir = path.join(allowedRoots[0] ?? process.cwd(), 'capabilities'),
  routingAuditLogger?: RoutingAuditLogger,
  memoryConfig?: MemoryConfig,
  executionConfig?: ExecutionConfig,
  githubConfig?: GitHubConfig,
  githubDependencies?: GitHubServiceDependencies,
): RuntimeServices {
  const workspace = new WorkspacePolicy(allowedRoots);
  const capabilities = CapabilityRegistry.open(capabilityDir);
  const defaults = loadConfig({}, allowedRoots[0] ?? process.cwd());
  const resolvedMemoryConfig = memoryConfig ?? defaults.memory;
  const resolvedExecutionConfig = executionConfig ?? defaults.execution;
  const resolvedGitHubConfig = githubConfig ?? defaults.github;
  const memory = new MemoryService(resolvedMemoryConfig);
  const executionStore = new ExecutionStore();
  const executionBridge = new ExecutionMemoryBridge(
    executionStore,
    memory,
    new ExecutionLogStore(resolvedExecutionConfig.logRoot),
  );
  const execution = new ExecutionService(resolvedExecutionConfig, workspace, {
    store: executionStore,
    memoryBridge: executionBridge,
    memorySearch: new ExecutionMemoryPreSearch(memory),
  });
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
    memory,
    execution,
    github: new GitHubService(resolvedGitHubConfig, workspace, githubDependencies),
  };
}
