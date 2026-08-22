import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CapabilityRecord, CapabilityType } from './types.js';

const TOP_LEVEL_TYPES: Record<string, CapabilityType> = {
  frameworks: 'framework',
  collections: 'collection',
  guides: 'guide',
  utilities: 'utility',
};

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split('|').map((cell) => cell.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownLink(cell: string): { label: string; url: string } | null {
  const match = cell.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  return match ? { label: match[1]!.trim(), url: match[2]!.trim() } : null;
}

function cleanText(value: string): string {
  return value.replace(/`([^`]+)`/g, '$1').replace(/\*\*/g, '').trim();
}

function canonicalName(value: string): { name: string; displayName: string; aliases: string[] } {
  const linked = markdownLink(value);
  const displayName = cleanText(linked?.label ?? value);
  const name = displayName.replace(/\s+(공식|official)$/i, '').trim();
  return { name: name || displayName, displayName, aliases: name !== displayName ? [displayName] : [] };
}

function sectionType(line: string): CapabilityType | null {
  const value = line.toLowerCase();
  if (value.includes('agents')) return 'agent';
  if (value.includes('skills')) return 'skill';
  if (value.includes('commands')) return 'command';
  if (value.includes('hooks')) return 'hook';
  return null;
}

function sourceFromUrl(url: string): CapabilityRecord['source'] {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return { url, repo: null, path: null, sha: null };
    const parts = parsed.pathname.split('/').filter(Boolean);
    const repo = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
    let sourcePath: string | null = null;
    if (parts[2] === 'blob' || parts[2] === 'tree') {
      sourcePath = parts.length > 4 ? parts.slice(4).join('/') : null;
    }
    return { url, repo, path: sourcePath, sha: null };
  } catch {
    return { url, repo: null, path: null, sha: null };
  }
}

function parseCompatibility(value: string): string[] {
  const clean = cleanText(value);
  if (!clean) return [];
  return [...new Set(clean.split(/[\/,]+/).map((item) => item.trim()).filter(Boolean))];
}

function parseLanguage(value: string): string[] {
  const clean = cleanText(value);
  return clean ? [clean] : [];
}

function invocationFor(type: CapabilityType, name: string, category: string) {
  if (type === 'skill') return {
    invocation: 'auto_candidate' as const,
    triggers: [`intent:${category}`, `capability:${name.toLowerCase().replace(/\s+/g, '-')}`],
    inputsContext: ['task_context'],
  };
  if (type === 'agent') return {
    invocation: 'router_or_explicit' as const,
    triggers: [`expertise:${category}`, `role:${name.toLowerCase().replace(/\s+/g, '-')}`],
    inputsContext: ['task_context'],
  };
  if (type === 'command') return {
    invocation: 'manual_only' as const,
    triggers: [`manual:${name}`],
    inputsContext: ['task_context'],
  };
  if (type === 'hook') return {
    invocation: 'disabled' as const,
    triggers: [`event:${name}`],
    inputsContext: ['event_context'],
  };
  return {
    invocation: 'reference_only' as const,
    triggers: [`reference:${category}`],
    inputsContext: ['unknown_from_catalog'],
  };
}

function stableId(record: { type: CapabilityType; category: string; name: string; source: CapabilityRecord['source'] }): string {
  const identity = [record.source.url, record.source.path ?? '@repo', record.type, record.name, record.category].join('|');
  return `cap_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function equivalenceGroup(record: { type: CapabilityType; name: string; source: CapabilityRecord['source'] }): string {
  const identity = [
    (record.source.repo ?? record.source.url).toLowerCase(),
    (record.source.path ?? '@repo').toLowerCase(),
    record.type,
    record.name.toLowerCase(),
  ].join('|');
  return `eq_${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
}

function buildRecord(args: {
  headers: string[];
  cells: string[];
  type: CapabilityType;
  category: string;
  categoryTitle: string;
  categoryPurpose: string;
  catalogSha: string;
  catalogFile: string;
  catalogRow: number;
}): CapabilityRecord | null {
  const row = new Map(args.headers.map((header, index) => [cleanText(header), args.cells[index] ?? '']));
  const sourceCell = row.get('레포') ?? row.get('Repo') ?? row.get('Repository') ?? '';
  const sourceLink = markdownLink(sourceCell) ?? args.cells.map(markdownLink).find(Boolean) ?? null;
  if (!sourceLink) return null;

  const nameCell = row.get('이름') ?? sourceCell;
  const names = canonicalName(nameCell);
  const source = sourceFromUrl(sourceLink.url);
  const description = cleanText(row.get('설명') ?? row.get('Description') ?? '');
  const scale = cleanText(row.get('규모') ?? '');
  const declaredPurpose = description || [args.categoryPurpose, scale].filter(Boolean).join(' — ');
  const behavior = invocationFor(args.type, names.name, args.category);
  const partial = { type: args.type, category: args.category, name: names.name, source };

  return {
    id: stableId(partial),
    name: names.name,
    displayName: names.displayName,
    aliases: names.aliases,
    type: args.type,
    category: args.category,
    categoryTitle: args.categoryTitle,
    declaredPurpose,
    functionalSummary: declaredPurpose,
    source,
    compatibility: parseCompatibility(row.get('도구') ?? row.get('Tools') ?? ''),
    language: parseLanguage(row.get('언어') ?? row.get('Language') ?? ''),
    triggers: behavior.triggers,
    invocation: behavior.invocation,
    inputsContext: behavior.inputsContext,
    outputsArtifacts: ['unknown_from_catalog'],
    requiredTools: [],
    dependencies: [],
    sideEffects: ['unknown_from_catalog'],
    risk: 'unknown',
    license: { status: 'unknown', id: null },
    state: 'cataloged',
    nativeEligible: false,
    normalizedPath: null,
    equivalenceGroup: equivalenceGroup(partial),
    catalogSha: args.catalogSha,
    catalogFile: args.catalogFile,
    catalogRow: args.catalogRow,
  };
}

async function parseCategoryFile(filePath: string, catalogSha: string): Promise<CapabilityRecord[]> {
  const text = await readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const category = path.basename(filePath, '.md');
  const categoryTitle = cleanText(lines.find((line) => line.startsWith('# '))?.slice(2) ?? category);
  const categoryPurpose = cleanText(lines.find((line) => line.startsWith('> ') && !line.includes('📦'))?.slice(2) ?? '');
  const expectedMatch = text.match(/CAT_STATS:START[\s\S]*?\*\*(\d+)[^*]*\*\*/);
  const expectedCount = expectedMatch ? Number.parseInt(expectedMatch[1]!, 10) : null;
  const topLevelType = TOP_LEVEL_TYPES[category] ?? null;
  const records: CapabilityRecord[] = [];
  let currentSection: CapabilityType | null = null;
  let activeHeaders: string[] | null = null;
  let activeTableType: CapabilityType | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.startsWith('## ')) {
      currentSection = sectionType(line);
      activeHeaders = null;
      activeTableType = null;
      continue;
    }
    if (!line.startsWith('|')) continue;

    const cells = splitRow(line);
    const nextCells = splitRow(lines[index + 1]?.trim() ?? '');
    if (isSeparatorRow(nextCells)) {
      activeHeaders = cells;
      activeTableType = currentSection ?? topLevelType;
      index += 1;
      continue;
    }
    if (isSeparatorRow(cells) || !activeHeaders || !activeTableType) continue;

    const record = buildRecord({
      headers: activeHeaders,
      cells,
      type: activeTableType,
      category,
      categoryTitle,
      categoryPurpose,
      catalogSha,
      catalogFile: path.basename(filePath),
      catalogRow: index + 1,
    });
    if (record) records.push(record);
  }

  if (expectedCount !== null && records.length !== expectedCount) {
    throw new Error(`${path.basename(filePath)} catalog count mismatch: expected ${expectedCount}, parsed ${records.length}`);
  }
  return records;
}

export async function parseCatalog(root: string, catalogSha: string): Promise<CapabilityRecord[]> {
  const categoriesDir = path.join(root, 'categories');
  const files = (await readdir(categoriesDir)).filter((name) => name.endsWith('.md')).sort();
  const results = await Promise.all(files.map((name) => parseCategoryFile(path.join(categoriesDir, name), catalogSha)));
  return results.flat().sort((a, b) => a.id.localeCompare(b.id));
}
