import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityLicense, CapabilityRisk, CapabilityState } from './types.js';

export interface AuditSkillSourceInput {
  capabilityId: string;
  repoRoot: string;
  skillPath: string;
  sourceRepo: string;
  sourceUrl: string;
  sourceCommitSha: string;
}

export interface SkillAudit {
  capabilityId: string;
  sourceRepo: string;
  sourceUrl: string;
  sourceCommitSha: string;
  sourcePath: string;
  sourceText: string;
  sourceContentSha256: string;
  licenseText: string | null;
  licensePath: string | null;
  license: CapabilityLicense;
  functionSummary: string;
  requiredTools: string[];
  dependencies: string[];
  sideEffects: string[];
  risk: CapabilityRisk;
  functionAnalyzed: boolean;
  safetyReviewed: boolean;
  eligible: boolean;
  state: CapabilityState;
}
const LICENSE_NAMES = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING', 'COPYING.txt'];
const TEXT_FILE_PATTERN = /\.(?:md|txt|json|ya?ml|ps1|sh|cmd|bat|py|js|mjs|cjs|ts)$/i;

function normalizeToolName(value: string): string {
  return value.trim().replace(/[`'".]/g, '').replace(/\s+/g, '_').toLowerCase();
}

function extractRequiredTools(text: string): string[] {
  const match = text.match(/^\s*Required tools\s*:\s*(.+)$/im);
  if (!match?.[1]) return [];
  return [...new Set(match[1].split(',').map(normalizeToolName).filter(Boolean))];
}

function extractDescription(text: string): string {
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const description = frontmatter?.[1]?.match(/^description:\s*(.+)$/im)?.[1]?.trim();
  if (description) return description.replace(/^['"]|['"]$/g, '');
  const heading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || 'Audited skill instructions';
}

function detectLicense(text: string | null): CapabilityLicense {
  if (!text) return { status: 'unknown', id: null };
  const lower = text.toLowerCase();
  if (lower.includes('mit license') && lower.includes('permission is hereby granted')) {
    return { status: 'verified', id: 'MIT' };
  }
  if (lower.includes('apache license') && lower.includes('version 2.0')) {
    return { status: 'verified', id: 'Apache-2.0' };
  }
  if (lower.includes('cc0 1.0 universal') || lower.includes('creative commons zero')) {
    return { status: 'verified', id: 'CC0-1.0' };
  }
  if (lower.includes('redistribution and use in source and binary forms') && lower.includes('disclaimer')) {
    return { status: 'verified', id: 'BSD-like' };
  }
  if (
    lower.includes('all rights reserved') ||
    lower.includes('may not reproduce') ||
    lower.includes('may not copy') ||
    lower.includes('may not distribute') ||
    lower.includes('may not create derivative')
  ) {
    return { status: 'incompatible', id: 'restricted' };
  }
  return { status: 'unknown', id: null };
}

async function findLicense(repoRoot: string, skillDir: string): Promise<{ path: string | null; text: string | null }> {
  for (const root of [skillDir, repoRoot]) {
    for (const name of LICENSE_NAMES) {
      const candidate = path.join(root, name);
      try {
        await access(candidate);
        return { path: candidate, text: await readFile(candidate, 'utf8') };
      } catch {
        // Try the next conventional license filename.
      }
    }
  }
  return { path: null, text: null };
}

function extractLocalReferences(sourceText: string): string[] {
  const matches = sourceText.matchAll(/(?:^|[\s`'"(])((?:\.?\.?[\\/])?(?:[\w.-]+[\\/])*[\w.-]+\.(?:md|txt|json|ya?ml|ps1|sh|cmd|bat|py|js|mjs|cjs|ts))(?:$|[\s`'"),:])/gim);
  const refs = [...matches]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .filter((value) => !/^skill\.md$/i.test(value))
    .filter((value) => TEXT_FILE_PATTERN.test(value));
  return [...new Set(refs)];
}

async function collectSupportingText(sourceText: string, skillDir: string, repoRoot: string): Promise<string> {
  const chunks: string[] = [];
  for (const reference of extractLocalReferences(sourceText).slice(0, 100)) {
    const candidate = path.resolve(skillDir, reference.replace(/[\\/]+/g, path.sep));
    const relative = path.relative(repoRoot, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    try {
      const text = await readFile(candidate, 'utf8');
      chunks.push(`\n--- FILE: ${reference} ---\n${text.slice(0, 256_000)}`);
    } catch {
      // Missing or non-text references remain visible through the source audit metadata only.
    }
  }
  return chunks.join('\n');
}
function analyzeRisk(text: string): { risk: CapabilityRisk; sideEffects: string[]; dependencies: string[] } {
  const lower = text.toLowerCase();
  const sideEffects = new Set<string>();
  const dependencies = new Set<string>();
  let risk: CapabilityRisk = 'low';

  const highRiskPatterns = [
    /remove-item[^\n]*(?:-recurse|-force)[^\n]*(?:c:\\|[a-z]:\\\*)/i,
    /\brm\s+-rf\s+\/(?:\s|$|\*)/i,
    /\bformat\s+[a-z]:/i,
    /\bdiskpart\b/i,
    /\bbcdedit\b/i,
    /\breg\s+delete\b/i,
    /\bshutdown\b/i,
  ];
  if (highRiskPatterns.some((pattern) => pattern.test(text))) {
    risk = 'high';
    sideEffects.add('destructive_filesystem');
  }

  if (/\b(?:sudo|runas|set-executionpolicy)\b/i.test(text)) {
    sideEffects.add('privilege_or_policy_change');
    if (risk !== 'high') risk = 'medium';
  }
  if (
    /\b(?:curl|wget|invoke-webrequest)\b/i.test(text) ||
    /\b(?:fetch|download|upload|scrape)\b[^\n]{0,80}\b(?:url|http|api|website|web)\b/i.test(text) ||
    /\b(?:call|query|request)\b[^\n]{0,80}\b(?:api|endpoint|server)\b/i.test(text)
  ) {
    sideEffects.add('network_access');
    if (risk === 'low') risk = 'medium';
  }
  if (/\b(?:npm|pnpm|yarn|pip|uv|cargo)\s+(?:install|add)\b/i.test(text)) {
    sideEffects.add('package_installation');
    dependencies.add('package_manager');
    if (risk === 'low') risk = 'medium';
  }
  if (/\b(?:hook|before every task|after every task|on every prompt)\b/i.test(lower)) {
    sideEffects.add('automatic_trigger');
    if (risk === 'low') risk = 'medium';
  }
  if (/\b(?:secret|token|api key|credential)\b/i.test(lower)) {
    sideEffects.add('credential_handling');
    if (risk === 'low') risk = 'medium';
  }

  return { risk, sideEffects: [...sideEffects], dependencies: [...dependencies] };
}
export async function auditSkillSource(input: AuditSkillSourceInput): Promise<SkillAudit> {
  const sourcePath = path.resolve(input.repoRoot, input.skillPath);
  const repoRoot = path.resolve(input.repoRoot);
  const relative = path.relative(repoRoot, sourcePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Skill path must stay inside the source repository');
  }

  const sourceText = await readFile(sourcePath, 'utf8');
  const skillDir = path.dirname(sourcePath);
  const supportText = await collectSupportingText(sourceText, skillDir, repoRoot);
  const licenseSource = await findLicense(repoRoot, skillDir);
  const license = detectLicense(licenseSource.text);
  const analysisText = `${sourceText}\n${supportText}`;
  const riskAnalysis = analyzeRisk(analysisText);
  const functionSummary = extractDescription(sourceText);
  const requiredTools = extractRequiredTools(sourceText);
  const functionAnalyzed = sourceText.trim().length > 0 && functionSummary.length > 0;
  const safetyReviewed = true;
  const eligible = license.status === 'verified' && functionAnalyzed && safetyReviewed && riskAnalysis.risk === 'low';

  let state: CapabilityState = 'safety_reviewed';
  if (license.status === 'unknown') state = 'license_unknown';
  else if (license.status === 'incompatible') state = 'reference_only';
  else if (riskAnalysis.risk === 'high') state = 'quarantined';

  return {
    capabilityId: input.capabilityId,
    sourceRepo: input.sourceRepo,
    sourceUrl: input.sourceUrl,
    sourceCommitSha: input.sourceCommitSha,
    sourcePath,
    sourceText,
    sourceContentSha256: createHash('sha256').update(sourceText).digest('hex'),
    licenseText: licenseSource.text,
    licensePath: licenseSource.path,
    license,
    functionSummary,
    requiredTools,
    dependencies: riskAnalysis.dependencies,
    sideEffects: riskAnalysis.sideEffects,
    risk: riskAnalysis.risk,
    functionAnalyzed,
    safetyReviewed,
    eligible,
    state,
  };
}
