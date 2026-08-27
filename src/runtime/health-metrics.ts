import type { RuntimeMetricRegistry, RuntimeMetricSnapshot } from './metric-window.js';

export type OverallHealth = 'healthy' | 'degraded' | 'critical';
export type ApiHealth = 'green' | 'yellow' | 'red';
export type CredentialHealth = 'valid' | 'missing' | 'invalid' | 'unknown';

export interface RuntimeHealthMetricsOptions {
  now?: () => number;
  githubProbeTtlMs?: number;
}

type HealthRuntime = {
  metrics: RuntimeMetricRegistry;
  memory: { config: { enabled: boolean }; currentState: string; status(scope?: unknown): Promise<any> };
  execution: {
    config: { enabled: boolean }; currentState: string; health(scope?: unknown): Promise<any>;
    store: { systemCounts(): Promise<any> };
  };
  github: { config: { enabled: boolean }; status(): Promise<any>; apiRequest(input: any): Promise<any> };
  routes: { metrics(): any };
  capabilities: { coverage(): any };
};

export interface RuntimeHealthSnapshot extends Record<string, unknown> {
  timestamp: number;
  memory: Record<string, unknown>;
  execution: Record<string, unknown>;
  github: Record<string, unknown>;
  routing: Record<string, unknown>;
  overallHealth: OverallHealth;
}

function metricView(metric: RuntimeMetricSnapshot) {
  return {
    count: metric.count,
    p50Ms: metric.p50,
    p95Ms: metric.p95,
    p99Ms: metric.p99,
    maxMs: metric.max,
    ...(metric.lastFailureCode ? { lastFailureCode: metric.lastFailureCode } : {}),
    ...(metric.lastFailureAt === undefined ? {} : { lastFailureAt: metric.lastFailureAt }),
  };
}

export class RuntimeHealthMetrics {
  private readonly now: () => number;
  private readonly githubProbeTtlMs: number;
  private githubProbeExpiresAt = 0;
  private githubProbeValue: { apiHealth: ApiHealth; credentialStatus: CredentialHealth; lastApiCheckMs: number | null; lastFailureCode?: string } | null = null;
  private githubProbePromise?: Promise<{ apiHealth: ApiHealth; credentialStatus: CredentialHealth; lastApiCheckMs: number | null; lastFailureCode?: string }>;

  constructor(private readonly runtime: HealthRuntime, options: RuntimeHealthMetricsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.githubProbeTtlMs = Math.max(100, options.githubProbeTtlMs ?? 60_000);
  }

  async getMetrics(): Promise<RuntimeHealthSnapshot> {
    const [memory, execution, executionCounts, github] = await Promise.all([
      this.runtime.memory.status(),
      this.runtime.execution.health(),
      this.runtime.execution.store.systemCounts(),
      this.githubMetrics(),
    ]);
    const routing = this.runtime.routes.metrics();
    const memoryCritical = Boolean(this.runtime.memory.config.enabled && !memory.healthy);
    const executionCritical = Boolean(this.runtime.execution.config.enabled && !execution.healthy);
    const optionalDegraded = this.runtime.github.config.enabled && (github.apiHealth !== 'green' || github.credentialStatus !== 'valid');
    const overallHealth: OverallHealth = memoryCritical || executionCritical ? 'critical' : optionalDegraded ? 'degraded' : 'healthy';
    return {
      timestamp: this.now(),
      memory: {
        enabled: Boolean(memory.enabled),
        healthy: Boolean(memory.healthy),
        state: this.runtime.memory.currentState,
        dbSize: Number(memory.counts?.db_bytes ?? 0),
        itemCount: Number(memory.counts?.active_items ?? 0),
        query: metricView(this.runtime.metrics.metric('memory.search.duration_ms')),
        preflight: metricView(this.runtime.metrics.metric('memory.preflight.duration_ms')),
        integrity: String(memory.integrity ?? 'unknown'),
      },
      execution: {
        enabled: Boolean(execution.enabled),
        healthy: Boolean(execution.healthy),
        state: this.runtime.execution.currentState,
        activeRuns: Number(execution.activeRuns ?? executionCounts.activeRuns ?? 0),
        queuedNodes: Number(executionCounts.queuedNodes ?? 0),
        runningNodes: Number(executionCounts.runningNodes ?? 0),
        queuedMemorySync: Number(execution.queuedSync ?? executionCounts.queuedSync ?? 0),
        dag: metricView(this.runtime.metrics.metric('execution.dag_validation.duration_ms')),
        dispatch: metricView(this.runtime.metrics.metric('execution.dispatch.duration_ms')),
        wake: metricView(this.runtime.metrics.metric('execution.wake_delivery.duration_ms')),
        integrity: String(execution.integrity ?? 'unknown'),
      },
      github,
      routing: {
        ...routing,
        capabilityStage: 'v5-local-continuity-execution-fabric',
      },
      overallHealth,
    };
  }

  private async githubMetrics() {
    if (!this.runtime.github.config.enabled) {
      return { enabled: false, apiHealth: 'green' as const, credentialStatus: 'unknown' as const, lastApiCheckMs: null };
    }
    const now = this.now();
    if (this.githubProbeValue && now < this.githubProbeExpiresAt) return { enabled: true, ...this.githubProbeValue };
    if (!this.githubProbePromise) this.githubProbePromise = this.probeGithub();
    try {
      this.githubProbeValue = await this.githubProbePromise;
      this.githubProbeExpiresAt = this.now() + this.githubProbeTtlMs;
      return { enabled: true, ...this.githubProbeValue };
    } finally {
      this.githubProbePromise = undefined;
    }
  }

  private async probeGithub() {
    const status = await this.runtime.github.status();
    if (!status.githubTokenConfigured) {
      return { apiHealth: 'red' as const, credentialStatus: 'missing' as const, lastApiCheckMs: null };
    }
    const started = this.now();
    try {
      const result = await this.runtime.github.apiRequest({ method: 'GET', endpoint: '/user' });
      const elapsed = Math.max(0, this.now() - started);
      if (Number(result?.status ?? 0) >= 200 && Number(result?.status ?? 0) < 300) {
        return { apiHealth: 'green' as const, credentialStatus: 'valid' as const, lastApiCheckMs: elapsed };
      }
      return { apiHealth: 'yellow' as const, credentialStatus: 'unknown' as const, lastApiCheckMs: elapsed, lastFailureCode: `HTTP_${result?.status ?? 'UNKNOWN'}` };
    } catch (error) {
      const elapsed = Math.max(0, this.now() - started);
      const code = error instanceof Error && 'code' in error ? String((error as any).code) : 'GITHUB_API_ERROR';
      const invalid = /AUTH|CREDENTIAL|401/.test(code);
      return { apiHealth: 'red' as const, credentialStatus: invalid ? 'invalid' as const : 'unknown' as const, lastApiCheckMs: elapsed, lastFailureCode: code };
    }
  }
}
