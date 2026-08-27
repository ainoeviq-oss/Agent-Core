export interface RuntimeMetricSnapshot {
  count: number;
  windowSize: number;
  last: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
  lastFailureCode?: string;
  lastFailureAt?: number;
}

export interface RuntimeMetricRegistryOptions {
  sampleCapacity?: number;
  now?: () => number;
}

interface MetricState {
  count: number;
  samples: number[];
  lastFailureCode?: string;
  lastFailureAt?: number;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1));
  return ordered[index] ?? null;
}

function safeFailureCode(value: string): string {
  return value.normalize('NFKC').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160) || 'UNKNOWN';
}

export class RuntimeMetricRegistry {
  private readonly states = new Map<string, MetricState>();
  private readonly counters = new Map<string, number>();
  private readonly sampleCapacity: number;
  private readonly now: () => number;

  constructor(options: RuntimeMetricRegistryOptions = {}) {
    this.sampleCapacity = Math.max(1, Math.min(options.sampleCapacity ?? 128, 4096));
    this.now = options.now ?? Date.now;
  }

  observe(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const state = this.states.get(name) ?? { count: 0, samples: [] };
    state.count += 1;
    state.samples.push(value);
    if (state.samples.length > this.sampleCapacity) state.samples.splice(0, state.samples.length - this.sampleCapacity);
    this.states.set(name, state);
  }

  failure(name: string, code: string): void {
    const state = this.states.get(name) ?? { count: 0, samples: [] };
    state.lastFailureCode = safeFailureCode(code);
    state.lastFailureAt = this.now();
    this.states.set(name, state);
  }

  increment(name: string, amount = 1): number {
    const next = (this.counters.get(name) ?? 0) + amount;
    this.counters.set(name, next);
    return next;
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  metric(name: string): RuntimeMetricSnapshot {
    const state = this.states.get(name) ?? { count: 0, samples: [] };
    return {
      count: state.count,
      windowSize: state.samples.length,
      last: state.samples.at(-1) ?? null,
      p50: percentile(state.samples, 0.50),
      p95: percentile(state.samples, 0.95),
      p99: percentile(state.samples, 0.99),
      max: state.samples.length > 0 ? Math.max(...state.samples) : null,
      ...(state.lastFailureCode ? { lastFailureCode: state.lastFailureCode } : {}),
      ...(state.lastFailureAt === undefined ? {} : { lastFailureAt: state.lastFailureAt }),
    };
  }
}
