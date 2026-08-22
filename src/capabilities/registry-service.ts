import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  CapabilityRecord,
  CapabilityRisk,
  CapabilityState,
  CapabilityType,
  CoverageReport,
} from './types.js';

export interface CapabilitySearchFilters {
  type?: CapabilityType;
  category?: string;
  risk?: CapabilityRisk;
  state?: CapabilityState;
  compatibility?: string;
  limit?: number;
}

export interface CapabilitySummary {
  id: string;
  name: string;
  type: CapabilityType;
  category: string;
  declaredPurpose: string;
  state: CapabilityState;
  risk: CapabilityRisk;
  nativeEligible: boolean;
  compatibility: string[];
  language: string[];
  invocation: CapabilityRecord['invocation'];
  sourceUrl: string;
  score?: number;
}

interface CatalogFile {
  version: number;
  catalogSha: string;
  coverage: CoverageReport;
  records: CapabilityRecord[];
}

function emptyCoverage(): CoverageReport {
  return {
    catalogSha: 'none',
    generatedAt: new Date(0).toISOString(),
    total: 0,
    byType: {},
    byState: {},
    nativeReady: 0,
    referenceOnly: 0,
    quarantined: 0,
    unresolved: 0,
  };
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}+#.]+/gu) ?? [])
    .map((token) => token.trim())
    .filter(Boolean);
}

function summary(record: CapabilityRecord, score?: number): CapabilitySummary {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    category: record.category,
    declaredPurpose: record.declaredPurpose,
    state: record.state,
    risk: record.risk,
    nativeEligible: record.nativeEligible,
    compatibility: record.compatibility,
    language: record.language,
    invocation: record.invocation,
    sourceUrl: record.source.url,
    ...(score === undefined ? {} : { score }),
  };
}

function scoreRecord(record: CapabilityRecord, query: string): number {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return 1;
  const weighted = [
    [record.name, 8],
    [record.aliases.join(' '), 6],
    [record.category, 4],
    [record.declaredPurpose, 5],
    [record.functionalSummary, 4],
    [record.triggers.join(' '), 3],
    [record.compatibility.join(' '), 1],
  ] as const;
  let score = 0;
  for (const token of queryTokens) {
    for (const [value, weight] of weighted) {
      if (value.toLowerCase().includes(token)) score += weight;
    }
  }
  if (record.name.toLowerCase() === query.trim().toLowerCase()) score += 25;
  if (record.state === 'native_ready') score += 1;
  return score;
}

export class CapabilityRegistry {
  private readonly byId: Map<string, CapabilityRecord>;

  private constructor(
    private readonly capabilityDir: string,
    private readonly records: CapabilityRecord[],
    private readonly report: CoverageReport,
  ) {
    this.byId = new Map(records.map((record) => [record.id, record]));
  }

  static open(capabilityDir: string): CapabilityRegistry {
    const catalogPath = path.join(capabilityDir, 'registry', 'catalog.json');
    if (!existsSync(catalogPath)) return new CapabilityRegistry(capabilityDir, [], emptyCoverage());
    const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogFile;
    if (!Array.isArray(parsed.records) || !parsed.coverage) {
      throw new Error('Capability registry catalog is malformed');
    }
    return new CapabilityRegistry(capabilityDir, parsed.records, parsed.coverage);
  }

  coverage(): CoverageReport {
    return structuredClone(this.report);
  }

  get(id: string): CapabilityRecord | null {
    const record = this.byId.get(id);
    return record ? structuredClone(record) : null;
  }

  search(query: string, filters: CapabilitySearchFilters = {}): CapabilitySummary[] {
    const limit = Math.max(1, Math.min(filters.limit ?? 20, 100));
    return this.records
      .filter((record) => !filters.type || record.type === filters.type)
      .filter((record) => !filters.category || record.category === filters.category)
      .filter((record) => !filters.risk || record.risk === filters.risk)
      .filter((record) => !filters.state || record.state === filters.state)
      .filter((record) => !filters.compatibility || record.compatibility.includes(filters.compatibility))
      .map((record) => ({ record, score: scoreRecord(record, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name) || a.record.id.localeCompare(b.record.id))
      .slice(0, limit)
      .map((entry) => summary(entry.record, entry.score));
  }

  recommend(task: string, context = '', limit = 8): CapabilitySummary[] {
    const combined = [task, context].filter(Boolean).join(' ');
    return this.search(combined, { limit });
  }

  dependencies(id: string) {
    const record = this.byId.get(id);
    if (!record) throw new Error(`Unknown capability: ${id}`);
    return {
      id: record.id,
      requiredTools: [...record.requiredTools],
      dependencies: [...record.dependencies],
      sideEffects: [...record.sideEffects],
      risk: record.risk,
      state: record.state,
      nativeEligible: record.nativeEligible,
    };
  }

  loadSkill(id: string): { capability: CapabilitySummary; instructions: string } {
    const record = this.byId.get(id);
    if (!record) throw new Error(`Unknown capability: ${id}`);
    if (record.type !== 'skill' || record.state !== 'native_ready' || !record.nativeEligible || !record.normalizedPath) {
      throw new Error(`Capability ${id} is not native-ready and cannot be loaded`);
    }
    const normalizedRoot = path.resolve(this.capabilityDir, 'normalized', 'skills');
    const fullPath = path.resolve(this.capabilityDir, record.normalizedPath);
    const relative = path.relative(normalizedRoot, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Capability ${id} normalized path escapes the audited skill directory`);
    }
    return {
      capability: summary(record),
      instructions: readFileSync(fullPath, 'utf8'),
    };
  }
}
