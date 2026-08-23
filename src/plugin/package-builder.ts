import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityRecord } from '../capabilities/types.js';

interface CatalogFile {
  records: CapabilityRecord[];
}

interface ProvenanceRecord {
  capabilityId: string;
  sourceRepo: string;
  sourceUrl: string;
  sourceCommitSha: string;
  licensePath: string;
  license: { status: string; id: string | null };
  risk: string;
  functionAnalyzed: boolean;
  safetyReviewed: boolean;
}

export interface BuildCommanderPluginOptions {
  capabilityDir: string;
  outputDir: string;
  routerSkillPath: string;
}

export interface CommanderPluginBuildResult {
  nativeSkillCount: number;
  skills: string[];
  outputDir: string;
}
function safeName(value: string): string {
  const normalized = value.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

function assertInside(root: string, candidate: string, label: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes allowed package source root`);
  }
}

async function loadCatalog(capabilityDir: string): Promise<CatalogFile> {
  const catalogPath = path.join(capabilityDir, 'registry', 'catalog.json');
  const parsed = JSON.parse(await readFile(catalogPath, 'utf8')) as CatalogFile;
  if (!Array.isArray(parsed.records)) throw new Error('Capability catalog is malformed');
  return parsed;
}

async function loadProvenance(capabilityDir: string, id: string): Promise<ProvenanceRecord> {
  const provenancePath = path.join(capabilityDir, 'provenance', `${id}.json`);
  return JSON.parse(await readFile(provenancePath, 'utf8')) as ProvenanceRecord;
}
function validateNativeRecord(record: CapabilityRecord, provenance: ProvenanceRecord): void {
  if (record.type !== 'skill' || record.state !== 'native_ready' || !record.nativeEligible || !record.normalizedPath) {
    throw new Error(`Capability ${record.id} is not eligible for native plugin packaging`);
  }
  if (
    provenance.capabilityId !== record.id ||
    provenance.license.status !== 'verified' ||
    provenance.risk !== 'low' ||
    !provenance.functionAnalyzed ||
    !provenance.safetyReviewed
  ) {
    throw new Error(`Capability ${record.id} failed provenance or safety packaging gates`);
  }
}

async function packageSkill(
  capabilityDir: string,
  outputDir: string,
  record: CapabilityRecord,
): Promise<string> {
  const provenance = await loadProvenance(capabilityDir, record.id);
  validateNativeRecord(record, provenance);
  const normalizedRoot = path.join(capabilityDir, 'normalized', 'skills');
  const sourceSkill = path.resolve(capabilityDir, record.normalizedPath!);
  assertInside(normalizedRoot, sourceSkill, 'Normalized skill path');
  assertInside(capabilityDir, provenance.licensePath, 'License path');

  const packageName = safeName(record.name);
  const destination = path.join(outputDir, 'skills', packageName);
  await mkdir(destination, { recursive: true });
  await Promise.all([
    cp(sourceSkill, path.join(destination, 'SKILL.md')),
    cp(provenance.licensePath, path.join(destination, 'LICENSE')),
    writeFile(
      path.join(destination, 'PROVENANCE.json'),
      `${JSON.stringify(provenance, null, 2)}\n`,
      'utf8',
    ),
  ]);
  return packageName;
}

export async function buildCommanderPluginPackage(
  options: BuildCommanderPluginOptions,
): Promise<CommanderPluginBuildResult> {
  const capabilityDir = path.resolve(options.capabilityDir);
  const outputDir = path.resolve(options.outputDir);
  const routerSkillPath = path.resolve(options.routerSkillPath);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(path.join(outputDir, 'skills', 'commander-capability-router'), { recursive: true });
  await cp(routerSkillPath, path.join(outputDir, 'skills', 'commander-capability-router', 'SKILL.md'));

  const catalog = await loadCatalog(capabilityDir);
  const nativeRecords = catalog.records.filter((record) =>
    record.type === 'skill' && record.state === 'native_ready' && record.nativeEligible && record.normalizedPath,
  );
  const packagedSkills: string[] = [];
  for (const record of nativeRecords) {
    packagedSkills.push(await packageSkill(capabilityDir, outputDir, record));
  }

  const packageMetadata = {
    format: 'commander-plugin-source-v1',
    name: 'Commander',
    description: 'Capability router skills plus the existing Desktop Commander MCP app.',
    app: {
      name: 'Desktop Commander',
      protocol: 'mcp',
      endpoint: '/mcp',
      binding: 'existing-connected-chatgpt-app',
      discovery: 'tools/list',
    },
    skills: ['commander-capability-router', ...packagedSkills],
    generatedFrom: {
      nativeReadyCount: nativeRecords.length,
      capabilityRegistry: 'local-audited-registry',
    },
  };
  await writeFile(
    path.join(outputDir, 'commander-package.json'),
    `${JSON.stringify(packageMetadata, null, 2)}\n`,
    'utf8',
  );

  return {
    nativeSkillCount: packagedSkills.length,
    skills: packageMetadata.skills,
    outputDir,
  };
}
