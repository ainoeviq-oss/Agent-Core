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

export interface BuildAgentCorePluginOptions {
  capabilityDir: string;
  outputDir: string;
  routerSkillPath: string;
  githubSkillPath: string;
}

export interface AgentCorePluginBuildResult {
  nativeSkillCount: number;
  skills: string[];
  outputDir: string;
}

const TRACKED_CORE_SKILLS = ['agent-core-capability-router', 'agent-core-github'] as const;

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

async function packageTrackedCoreSkill(outputDir: string, name: string, sourceSkillPath: string): Promise<void> {
  const resolved = path.resolve(sourceSkillPath);
  const destination = path.join(outputDir, 'skills', name, 'SKILL.md');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(resolved, destination);
}

export async function buildAgentCorePluginPackage(
  options: BuildAgentCorePluginOptions,
): Promise<AgentCorePluginBuildResult> {
  const capabilityDir = path.resolve(options.capabilityDir);
  const outputDir = path.resolve(options.outputDir);
  await rm(outputDir, { recursive: true, force: true });

  await Promise.all([
    packageTrackedCoreSkill(outputDir, 'agent-core-capability-router', options.routerSkillPath),
    packageTrackedCoreSkill(outputDir, 'agent-core-github', options.githubSkillPath),
  ]);

  const catalog = await loadCatalog(capabilityDir);
  const nativeRecords = catalog.records.filter((record) =>
    record.type === 'skill' && record.state === 'native_ready' && record.nativeEligible && record.normalizedPath,
  );
  const packagedSkills: string[] = [];
  for (const record of nativeRecords) {
    packagedSkills.push(await packageSkill(capabilityDir, outputDir, record));
  }

  const packageMetadata = {
    format: 'agent-core-plugin-source-v1',
    name: 'Agent Core',
    description: 'Tracked Agent Core routing and Native GitHub Fabric skills plus the existing Agent Core MCP app.',
    app: {
      name: 'Agent Core',
      protocol: 'mcp',
      endpoint: '/mcp',
      binding: 'existing-connected-chatgpt-app',
      discovery: 'tools/list',
    },
    skills: [...TRACKED_CORE_SKILLS, ...packagedSkills],
    generatedFrom: {
      nativeReadyCount: nativeRecords.length,
      capabilityRegistry: 'local-audited-registry',
    },
  };
  await writeFile(
    path.join(outputDir, 'agent-core-package.json'),
    `${JSON.stringify(packageMetadata, null, 2)}\n`,
    'utf8',
  );

  return {
    nativeSkillCount: packagedSkills.length,
    skills: packageMetadata.skills,
    outputDir,
  };
}
