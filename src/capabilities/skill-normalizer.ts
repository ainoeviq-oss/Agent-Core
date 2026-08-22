import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillAudit } from './source-audit.js';

export interface NormalizeSkillOptions {
  capabilityDir: string;
}

export interface NormalizedSkill {
  capabilityId: string;
  state: 'native_ready';
  skillPath: string;
  metadataPath: string;
  provenancePath: string;
  cacheSkillPath: string;
  cacheLicensePath: string | null;
}

function assertEligible(audit: SkillAudit): void {
  if (audit.license.status !== 'verified') {
    throw new Error(`Skill license is not verified: ${audit.license.status}`);
  }
  if (!audit.functionAnalyzed) throw new Error('Skill function analysis is incomplete');
  if (!audit.safetyReviewed) throw new Error('Skill safety review is incomplete');
  if (audit.risk === 'high' || audit.risk === 'unknown') {
    throw new Error(`Skill risk is not eligible for native loading: ${audit.risk}`);
  }
  if (!audit.eligible) throw new Error('Skill did not pass native eligibility gates');
}
export async function normalizeAuditedSkill(
  audit: SkillAudit,
  options: NormalizeSkillOptions,
): Promise<NormalizedSkill> {
  assertEligible(audit);

  const normalizedDir = path.join(options.capabilityDir, 'normalized', 'skills', audit.capabilityId);
  const cacheDir = path.join(options.capabilityDir, 'cache', 'sources', audit.capabilityId);
  const provenanceDir = path.join(options.capabilityDir, 'provenance');
  await Promise.all([
    mkdir(normalizedDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(provenanceDir, { recursive: true }),
  ]);

  const skillPath = path.join(normalizedDir, 'SKILL.md');
  const metadataPath = path.join(normalizedDir, 'metadata.json');
  const cacheSkillPath = path.join(cacheDir, 'SKILL.md');
  const provenancePath = path.join(provenanceDir, `${audit.capabilityId}.json`);
  const cacheLicensePath = audit.licenseText ? path.join(cacheDir, 'LICENSE.txt') : null;

  const metadata = {
    capabilityId: audit.capabilityId,
    functionSummary: audit.functionSummary,
    requiredTools: audit.requiredTools,
    dependencies: audit.dependencies,
    sideEffects: audit.sideEffects,
    risk: audit.risk,
    license: audit.license,
    state: 'native_ready',
  };
  const provenance = {
    capabilityId: audit.capabilityId,
    sourceRepo: audit.sourceRepo,
    sourceUrl: audit.sourceUrl,
    sourceCommitSha: audit.sourceCommitSha,
    sourcePath: audit.sourcePath,
    sourceContentSha256: audit.sourceContentSha256,
    licensePath: audit.licensePath,
    license: audit.license,
    auditedAt: new Date().toISOString(),
    risk: audit.risk,
    functionAnalyzed: audit.functionAnalyzed,
    safetyReviewed: audit.safetyReviewed,
  };

  await Promise.all([
    writeFile(skillPath, audit.sourceText, 'utf8'),
    writeFile(cacheSkillPath, audit.sourceText, 'utf8'),
    writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8'),
    writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, 'utf8'),
    ...(cacheLicensePath ? [writeFile(cacheLicensePath, audit.licenseText!, 'utf8')] : []),
  ]);

  return {
    capabilityId: audit.capabilityId,
    state: 'native_ready',
    skillPath,
    metadataPath,
    provenancePath,
    cacheSkillPath,
    cacheLicensePath,
  };
}
