import { EventEmitter } from 'node:events';
import type { ExecutionScope } from './types.js';
import type { ExecutionStore } from './store.js';

export const EXECUTION_EVENT_TYPES = [
  'run.created', 'run.started', 'node.queued', 'node.ready', 'node.started',
  'node.output_available', 'node.succeeded', 'node.failed', 'node.blocked',
  'node.interrupted', 'node.retry_started', 'node.cancelled', 'run.completed',
  'run.failed', 'run.blocked', 'run.interrupted', 'run.cancelled',
] as const;

export type ExecutionEventType = (typeof EXECUTION_EVENT_TYPES)[number];

export interface ExecutionEventRecord {
  runId: string;
  sequence: number;
  eventType: ExecutionEventType;
  nodeId?: string;
  attemptId?: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface ExecutionEventFilter {
  eventTypes?: ExecutionEventType[];
  nodeIds?: string[];
}

const EVENT_TYPE_SET = new Set<ExecutionEventType>(EXECUTION_EVENT_TYPES);

function matches(event: ExecutionEventRecord, filters?: ExecutionEventFilter): boolean {
  if (filters?.eventTypes?.length && !filters.eventTypes.includes(event.eventType)) return false;
  if (filters?.nodeIds?.length && (!event.nodeId || !filters.nodeIds.includes(event.nodeId))) return false;
  return true;
}

export class ExecutionWakeCoordinator {
  private readonly emitter = new EventEmitter();

  constructor(readonly store: ExecutionStore) {
    this.emitter.setMaxListeners(0);
  }

  async waitForEvent(
    scope: ExecutionScope,
    runId: string,
    afterSequence: number,
    filters: ExecutionEventFilter | undefined,
    timeoutMs: number,
  ): Promise<ExecutionEventRecord | null> {
    if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new Error('EXECUTION_EVENT_SEQUENCE_INVALID');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('EXECUTION_WAIT_TIMEOUT_INVALID');

    const existing = (await this.store.getEvents(scope, runId, afterSequence, filters, 1))[0];
    if (existing) return existing;

    const channel = this.channel(runId);
    let settled = false;
    let resolveWait!: (event: ExecutionEventRecord | null) => void;
    const waitPromise = new Promise<ExecutionEventRecord | null>((resolve) => { resolveWait = resolve; });
    const cleanup = () => {
      this.emitter.off(channel, listener);
      clearTimeout(timer);
    };
    const settle = (event: ExecutionEventRecord | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveWait(event);
    };
    const listener = (event: ExecutionEventRecord) => {
      if (event.sequence <= afterSequence || !matches(event, filters)) return;
      settle(event);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    this.emitter.on(channel, listener);

    // Close the query->subscribe race with one bounded post-subscription read.
    // There is no DB polling loop: after this check, only a persisted event signal or timeout can resolve the wait.
    try {
      const raced = (await this.store.getEvents(scope, runId, afterSequence, filters, 1))[0];
      if (raced) settle(raced);
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanup();
      }
      throw error;
    }
    return waitPromise;
  }

  publish(event: ExecutionEventRecord): void {
    this.emitter.emit(this.channel(event.runId), event);
  }

  private channel(runId: string): string {
    return `execution:${runId}`;
  }
}

export interface ExecutionEventJournalOptions {
  outputCoalesceMs?: number;
  now?: () => number;
}

export class ExecutionEventJournal {
  private readonly outputCoalesceMs: number;
  private readonly now: () => number;
  private readonly lastOutputEventAt = new Map<string, number>();

  constructor(
    readonly store: ExecutionStore,
    readonly wake: ExecutionWakeCoordinator,
    options: ExecutionEventJournalOptions = {},
  ) {
    this.outputCoalesceMs = options.outputCoalesceMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  async record(
    scope: ExecutionScope,
    runId: string,
    eventType: ExecutionEventType,
    options: { nodeId?: string; attemptId?: string; payload?: Record<string, unknown> } = {},
  ): Promise<ExecutionEventRecord | null> {
    if (!EVENT_TYPE_SET.has(eventType)) throw new Error(`EXECUTION_EVENT_TYPE_INVALID:${eventType}`);
    if (eventType === 'node.output_available') {
      if (!options.nodeId) throw new Error('EXECUTION_OUTPUT_NODE_REQUIRED');
      const key = `${runId}/${options.nodeId}`;
      const now = this.now();
      const previous = this.lastOutputEventAt.get(key);
      if (previous !== undefined && now - previous < this.outputCoalesceMs) return null;
      // Reserve the coalescing slot before the async DB write so concurrent chunks do not fan out.
      this.lastOutputEventAt.set(key, now);
      try {
        const event = await this.store.appendEvent(scope, runId, eventType, options);
        this.wake.publish(event); // persistence has completed before any signal is emitted
        return event;
      } catch (error) {
        if (this.lastOutputEventAt.get(key) === now) this.lastOutputEventAt.delete(key);
        throw error;
      }
    }

    const event = await this.store.appendEvent(scope, runId, eventType, options);
    this.wake.publish(event); // persist-before-signal invariant
    return event;
  }
}
