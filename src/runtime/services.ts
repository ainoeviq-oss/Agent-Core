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
import { RuntimeMetricRegistry } from './metric-window.js';
import { RuntimeHealthMetrics } from './health-metrics.js';

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
  metrics: RuntimeMetricRegistry;
  healthMetrics: RuntimeHealthMetrics;
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
  const metrics = new RuntimeMetricRegistry();
  const memory = new MemoryService(resolvedMemoryConfig, metrics);
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
    metrics,
  });
  const runtime = {
    workspace,
    filesystem: new FileSystemService(workspace),
    search: new SearchService(workspace),
    processes: new ProcessManager(workspace),
    capabilities,
    router: new CapabilityRouter(capabilities),
    routes: new RouteContextStore({ ...(routingAuditLogger ? { auditLogger: routingAuditLogger } : {}), metrics }),
    memory,
    execution,
    github: new GitHubService(resolvedGitHubConfig, workspace, { ...githubDependencies, metrics }),
    metrics,
  } as Omit<RuntimeServices, 'healthMetrics'> & { healthMetrics?: RuntimeHealthMetrics };
  runtime.healthMetrics = new RuntimeHealthMetrics(runtime as RuntimeServices);
  return runtime as RuntimeServices;
}
