import type { MemoryConfig } from '../config.js';
import { MemoryLifecycle } from './lifecycle.js';
import { MemoryLinker } from './linker.js';
import { MemoryPreflightEngine, createDisabledPreflightResult } from './preflight.js';
import { MemoryRetriever } from './retriever.js';
import { MEMORY_SCHEMA_VERSION } from './schema.js';
import { MemoryStore, type RecordMemoryEventRequest } from './store.js';
import type {
  MemoryCommitRequest,
  MemoryCommitResult,
  MemoryPreflightRequest,
  MemoryPreflightResult,
  MemoryReviseRequest,
  MemoryReviseResult,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStatus,
} from './types.js';
import { MemoryWorkerClient } from './worker-client.js';

interface MemoryComponents {
  client: MemoryWorkerClient;
  store: MemoryStore;
  retriever: MemoryRetriever;
  lifecycle: MemoryLifecycle;
  linker: MemoryLinker;
  preflight: MemoryPreflightEngine;
}

export interface MemoryContextRecord {
  contextId: string;
  routeContextId: string;
  queryText: string;
  queryHash: string;
  resultJson: string;
  blockingJson: string;
  createdAt: number;
  expiresAt: number;
}

export type MemoryServiceState = 'disabled' | 'idle' | 'healthy' | 'degraded' | 'closed';

export class MemoryService {
  private components: MemoryComponents | undefined;
  private opening: Promise<MemoryComponents> | undefined;
  private state: MemoryServiceState;
  private degradedReason: string | undefined;

  constructor(readonly config: MemoryConfig) {
    this.state = config.enabled ? 'idle' : 'disabled';
  }

  get currentState(): MemoryServiceState {
    return this.state;
  }

  async recordEvent(request: RecordMemoryEventRequest) {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    return components.store.recordEvent(request);
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitResult> {
    const components = await this.requireComponents();
    const result = await components.store.commitMemory(request);
    await components.linker.linkMemory(request.scope, result.memoryId);
    return result;
  }

  async revise(request: MemoryReviseRequest): Promise<MemoryReviseResult> {
    const components = await this.requireComponents();
    const result = await components.store.reviseMemory(request);
    await components.linker.linkMemory(request.scope, result.memoryId);
    return result;
  }

  async search(request: MemorySearchRequest): Promise<MemorySearchResult> {
    if (!this.config.enabled) {
      const result = createDisabledPreflightResult({
        scope: request.scope,
        routeContextId: 'disabled-search',
        task: request.query || 'disabled search',
        expiresAt: Date.now() + 1,
      });
      return { query: request.query, hits: [], graphTruncated: false, snapshotHash: result.snapshotHash };
    }
    const components = await this.requireComponents();
    return components.retriever.search(request);
  }

  async preflight(request: MemoryPreflightRequest): Promise<MemoryPreflightResult> {
    if (!this.config.enabled) return createDisabledPreflightResult(request);
    const components = await this.requireComponents();
    return components.preflight.run(request);
  }

  async openConflict(
    scope: MemoryScope,
    leftMemoryId: string,
    rightMemoryId: string,
    conflictType: string,
    evidence: Record<string, unknown>,
  ) {
    const components = await this.requireComponents();
    return components.lifecycle.openConflict(scope, leftMemoryId, rightMemoryId, conflictType, evidence);
  }

  async listOpenConflicts(scope: MemoryScope) {
    if (!this.config.enabled) return [];
    const components = await this.requireComponents();
    return components.lifecycle.listOpenConflicts(scope);
  }

  async getMemory(scope: MemoryScope, memoryId: string) {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    return components.store.getMemory(scope, memoryId);
  }

  async listRevisions(scope: MemoryScope, memoryId: string) {
    if (!this.config.enabled) return [];
    const components = await this.requireComponents();
    return components.store.listRevisions(scope, memoryId);
  }

  async forget(scope: MemoryScope, memoryId: string, reason: string): Promise<void> {
    const components = await this.requireComponents();
    await components.store.tombstoneMemory(scope, memoryId, reason);
  }

  async compact(scope: MemoryScope, now = Date.now()) {
    const components = await this.requireComponents();
    return components.lifecycle.compact(scope, now);
  }

  async getContext(scope: MemoryScope, contextId: string): Promise<MemoryContextRecord | null> {
    if (!this.config.enabled) return null;
    const components = await this.requireComponents();
    const rows = await components.client.query<Record<string, unknown>>(
      `SELECT id, route_context_id, query_text, query_hash, result_json, blocking_json, created_at, expires_at
         FROM memory_contexts
        WHERE id = ? AND principal_id = ? AND expires_at > ?
        LIMIT 1`,
      [contextId, scope.principalId, Date.now()],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      contextId: String(row.id),
      routeContextId: String(row.route_context_id),
      queryText: String(row.query_text),
      queryHash: String(row.query_hash),
      resultJson: String(row.result_json),
      blockingJson: String(row.blocking_json),
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    };
  }

  async status(): Promise<MemoryStatus> {
    if (!this.config.enabled) {
      return {
        enabled: false,
        healthy: false,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        dbPath: this.config.dbPath,
        counts: {},
        integrity: 'disabled',
      };
    }
    try {
      const components = await this.requireComponents();
      const [counts] = await components.client.query<Record<string, unknown>>(`SELECT
        (SELECT count(*) FROM memory_items WHERE state = 'active') AS active_items,
        (SELECT count(*) FROM memory_revisions) AS revisions,
        (SELECT count(*) FROM memory_edges) AS edges,
        (SELECT count(*) FROM memory_conflicts WHERE status = 'open') AS open_conflicts,
        (SELECT count(*) FROM memory_items WHERE state = 'tombstoned') AS tombstones,
        (SELECT count(*) FROM memory_fts) AS fts_rows`);
      const integrity = await components.client.integrity();
      return {
        enabled: true,
        healthy: integrity.ok,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        dbPath: this.config.dbPath,
        counts: Object.fromEntries(Object.entries(counts ?? {}).map(([key, value]) => [key, Number(value)])),
        integrity: integrity.result,
      };
    } catch (error) {
      return {
        enabled: true,
        healthy: false,
        schemaVersion: MEMORY_SCHEMA_VERSION,
        dbPath: this.config.dbPath,
        counts: {},
        integrity: `degraded:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return;
    const opening = this.opening;
    if (opening) {
      try { await opening; } catch { /* degraded initialization is already recorded */ }
    }
    if (this.components) await this.components.store.close();
    this.state = 'closed';
  }

  private async requireComponents(): Promise<MemoryComponents> {
    if (!this.config.enabled) throw new Error('MEMORY_DISABLED');
    if (this.state === 'closed') throw new Error('MEMORY_CLOSED');
    if (this.components && this.state === 'healthy') return this.components;
    if (this.state === 'degraded') throw new Error(`MEMORY_DEGRADED:${this.degradedReason ?? 'unknown'}`);
    if (this.opening) return this.opening;

    this.opening = this.openComponents();
    try {
      return await this.opening;
    } finally {
      this.opening = undefined;
    }
  }

  private async openComponents(): Promise<MemoryComponents> {
    const client = new MemoryWorkerClient();
    const store = new MemoryStore(client);
    const retriever = new MemoryRetriever(client, this.config);
    const lifecycle = new MemoryLifecycle(client, this.config);
    const linker = new MemoryLinker(client, {
      tokenOverlapJaccardThreshold: this.config.tokenOverlapJaccardThreshold,
      temporalNeighborWindowMs: this.config.temporalNeighborWindowMs,
      candidateCap: Math.min(512, this.config.seedCap),
    });
    const preflight = new MemoryPreflightEngine(client, retriever, lifecycle);
    const components = { client, store, retriever, lifecycle, linker, preflight };
    try {
      await store.open({ dbPath: this.config.dbPath, busyTimeoutMs: this.config.busyTimeoutMs });
      this.components = components;
      this.state = 'healthy';
      this.degradedReason = undefined;
      return components;
    } catch (error) {
      this.state = 'degraded';
      this.degradedReason = error instanceof Error ? error.message : String(error);
      try { await store.close(); } catch {}
      throw error;
    }
  }
}
