import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityRecord, CoverageReport } from './types.js';

export interface RegistryGenerationMetadata {
  catalogSha: string;
  generatedAt?: string;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function validateRecords(records: CapabilityRecord[], catalogSha: string): void {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Duplicate capability id: ${record.id}`);
    ids.add(record.id);
    if (!record.id || !record.name || !record.type || !record.category || !record.source.url) {
      throw new Error(`Invalid capability record: ${record.id || '<missing-id>'}`);
    }
    if (!record.declaredPurpose) throw new Error(`Capability ${record.id} is missing declared purpose`);
    if (record.catalogSha !== catalogSha) {
      throw new Error(`Capability ${record.id} catalog SHA does not match generation`);
    }
  }
}

function buildCoverage(records: CapabilityRecord[], catalogSha: string, generatedAt: string): CoverageReport {
  const byType: Record<string, number> = {};
  const byState: Record<string, number> = {};
  for (const record of records) {
    increment(byType, record.type);
    increment(byState, record.state);
  }
  return {
    catalogSha,
    generatedAt,
    total: records.length,
    byType,
    byState,
    nativeReady: byState.native_ready ?? 0,
    referenceOnly: byState.reference_only ?? 0,
    quarantined: byState.quarantined ?? 0,
    unresolved: byState.unresolved ?? 0,
  };
}

async function replaceFile(source: string, destination: string): Promise<void> {
  await rm(destination, { force: true });
  await rename(source, destination);
}

export async function writeRegistryGeneration(
  capabilityDir: string,
  records: CapabilityRecord[],
  metadata: RegistryGenerationMetadata,
): Promise<CoverageReport> {
  validateRecords(records, metadata.catalogSha);
  const generatedAt = metadata.generatedAt ?? new Date().toISOString();
  const coverage = buildCoverage(records, metadata.catalogSha, generatedAt);
  const registryDir = path.join(capabilityDir, 'registry');
  const stagingDir = path.join(registryDir, `.staging-${randomUUID()}`);
  const stagingItems = path.join(stagingDir, 'items');
  await mkdir(stagingItems, { recursive: true });

  try {
    await Promise.all(records.map((record) => writeFile(
      path.join(stagingItems, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    )));
    const catalog = {
      version: 1,
      catalogSha: metadata.catalogSha,
      generatedAt,
      coverage,
      records,
    };
    await writeFile(path.join(stagingDir, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    await writeFile(path.join(stagingDir, 'coverage.json'), `${JSON.stringify(coverage, null, 2)}\n`, 'utf8');

    const itemsDir = path.join(registryDir, 'items');
    await mkdir(itemsDir, { recursive: true });
    for (const record of records) {
      await replaceFile(
        path.join(stagingItems, `${record.id}.json`),
        path.join(itemsDir, `${record.id}.json`),
      );
    }
    await replaceFile(path.join(stagingDir, 'coverage.json'), path.join(registryDir, 'coverage.json'));
    await replaceFile(path.join(stagingDir, 'catalog.json'), path.join(registryDir, 'catalog.json'));
    return coverage;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
