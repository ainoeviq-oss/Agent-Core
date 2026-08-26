import path from 'node:path';
import { assertCommandAllowed } from '../runtime/process-manager.js';
import type { WorkspacePolicy } from '../runtime/workspace.js';
import type { ExecutionNodeState } from './types.js';

export type ExecutionArtifactKind = 'file' | 'directory';
export type ExecutionArtifactHash = 'sha256';

export interface ExecutionExpectedArtifactSpec {
  path: string;
  kind?: ExecutionArtifactKind;
  hash?: ExecutionArtifactHash;
  required?: boolean;
}

export interface ValidatedExecutionArtifact {
  path: string;
  kind: ExecutionArtifactKind;
  hash?: ExecutionArtifactHash;
  required: boolean;
}

export interface ExecutionNodeSpec {
  id: string;
  purpose: string;
  command: string;
  cwd: string;
  dependsOn?: string[];
  timeoutMs?: number;
  continueOnFailure?: boolean;
  expectedArtifacts?: ExecutionExpectedArtifactSpec[];
}

export interface ValidatedExecutionNode extends Omit<ExecutionNodeSpec, 'expectedArtifacts'> {
  dependsOn: string[];
  timeoutMs: number;
  continueOnFailure: boolean;
  expectedArtifacts: ValidatedExecutionArtifact[];
}

export interface ExecutionDag {
  nodes: ValidatedExecutionNode[];
  nodeById: Map<string, ValidatedExecutionNode>;
  topologicalOrder: string[];
}

export class ExecutionDagError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ExecutionDagError';
  }
}

const DEFAULT_MAX_NODES = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_EXPECTED_ARTIFACTS = 32;
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|client[_-]?secret|access[_-]?key|password|passwd|pwd|token|refresh[_-]?token|access[_-]?token)\s*[:=]\s*([^\s;,]+)/gi;
const BEARER_RE = /\b(?:authorization\s*:\s*)?bearer\s+([^\s,;]+)/gi;

function fail(code: string, message: string): never {
  throw new ExecutionDagError(code, message);
}

function normalizeRequired(value: unknown, field: string, code: string, max: number): string {
  if (typeof value !== 'string') fail(code, `${field} is required`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) fail(code, `${field} is required`);
  if (normalized.length > max) fail('EXECUTION_TEXT_TOO_LONG', `${field} exceeds ${max} characters`);
  return normalized;
}

function isReferenceValue(rawValue: string): boolean {
  const value = rawValue.trim().replace(/^["']|["']$/g, '');
  return /^\$env:/i.test(value)
    || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
    || /^%[A-Za-z_][A-Za-z0-9_]*%$/.test(value)
    || /^env:/i.test(value)
    || /^file:/i.test(value);
}

function hasInlineSecret(command: string): boolean {
  SECRET_ASSIGNMENT_RE.lastIndex = 0;
  for (let match = SECRET_ASSIGNMENT_RE.exec(command); match; match = SECRET_ASSIGNMENT_RE.exec(command)) {
    if (!isReferenceValue(match[2] ?? '')) return true;
  }
  BEARER_RE.lastIndex = 0;
  for (let match = BEARER_RE.exec(command); match; match = BEARER_RE.exec(command)) {
    if (!isReferenceValue(match[1] ?? '')) return true;
  }
  return false;
}

function normalizeDependencyIds(value: unknown, nodeId: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('EXECUTION_DEPENDENCIES_INVALID', `dependsOn for ${nodeId} must be an array`);
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string' || !NODE_ID_RE.test(raw.trim())) {
      fail('EXECUTION_DEPENDENCY_ID_INVALID', `Invalid dependency ID for ${nodeId}`);
    }
    seen.add(raw.trim());
  }
  return [...seen].sort((left, right) => left.localeCompare(right));
}

async function normalizeExpectedArtifacts(
  value: unknown,
  nodeId: string,
  cwd: string,
  workspace: WorkspacePolicy,
): Promise<ValidatedExecutionArtifact[]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('EXECUTION_ARTIFACTS_INVALID', `expectedArtifacts for ${nodeId} must be an array`);
  if (value.length > MAX_EXPECTED_ARTIFACTS) {
    fail('EXECUTION_ARTIFACT_LIMIT', `Node ${nodeId} exceeds ${MAX_EXPECTED_ARTIFACTS} expected artifacts`);
  }
  const result: ValidatedExecutionArtifact[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail('EXECUTION_ARTIFACT_INVALID', `expectedArtifacts[${index}] for ${nodeId} must be an object`);
    }
    const item = raw as Record<string, unknown>;
    const rawPath = normalizeRequired(item.path, `expectedArtifacts[${index}].path`, 'EXECUTION_ARTIFACT_PATH_REQUIRED', 5_000);
    const kind = item.kind === undefined ? 'file' : item.kind;
    if (kind !== 'file' && kind !== 'directory') {
      fail('EXECUTION_ARTIFACT_KIND_INVALID', `expectedArtifacts[${index}].kind for ${nodeId} is invalid`);
    }
    const hash = item.hash;
    if (hash !== undefined && hash !== 'sha256') {
      fail('EXECUTION_ARTIFACT_HASH_INVALID', `expectedArtifacts[${index}].hash for ${nodeId} is invalid`);
    }
    if (kind === 'directory' && hash !== undefined) {
      fail('EXECUTION_ARTIFACT_HASH_INVALID', `Directory artifact ${rawPath} cannot request a file hash`);
    }
    if (item.required !== undefined && typeof item.required !== 'boolean') {
      fail('EXECUTION_ARTIFACT_REQUIRED_INVALID', `expectedArtifacts[${index}].required for ${nodeId} must be boolean`);
    }
    const candidate = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
    let resolved: string;
    try {
      resolved = await workspace.resolveTarget(candidate);
    } catch {
      fail('EXECUTION_ARTIFACT_OUTSIDE_ROOT', `Artifact ${rawPath} for node ${nodeId} is outside allowed workspace roots`);
    }
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) fail('EXECUTION_ARTIFACT_DUPLICATE', `Duplicate expected artifact for node ${nodeId}: ${resolved}`);
    seen.add(identity);
    result.push({
      path: resolved,
      kind,
      ...(hash === 'sha256' ? { hash } : {}),
      required: item.required ?? true,
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export async function validateExecutionDag(
  nodes: ExecutionNodeSpec[],
  options: { workspace: WorkspacePolicy; maxNodes?: number },
): Promise<ExecutionDag> {
  if (!Array.isArray(nodes)) fail('EXECUTION_NODES_INVALID', 'nodes must be an array');
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 10_000) {
    fail('EXECUTION_NODE_LIMIT_INVALID', 'maxNodes must be an integer between 1 and 10000');
  }
  if (nodes.length < 1) fail('EXECUTION_NODES_REQUIRED', 'At least one execution node is required');
  if (nodes.length > maxNodes) fail('EXECUTION_NODE_LIMIT', `Execution DAG exceeds ${maxNodes} nodes`);
  if (!options.workspace) fail('EXECUTION_WORKSPACE_REQUIRED', 'workspace is required');

  const normalized: ValidatedExecutionNode[] = [];
  const seenIds = new Set<string>();
  const resolvedCwds = new Map<string, Promise<string>>();
  for (const rawNode of nodes) {
    if (!rawNode || typeof rawNode !== 'object') fail('EXECUTION_NODE_INVALID', 'Each node must be an object');
    const id = typeof rawNode.id === 'string' ? rawNode.id.normalize('NFKC').trim() : '';
    if (!NODE_ID_RE.test(id)) fail('EXECUTION_NODE_ID_INVALID', `Invalid execution node ID: ${String(rawNode.id)}`);
    if (seenIds.has(id)) fail('EXECUTION_NODE_DUPLICATE', `Duplicate execution node ID: ${id}`);
    seenIds.add(id);

    const purpose = normalizeRequired(rawNode.purpose, 'purpose', 'EXECUTION_PURPOSE_REQUIRED', 5_000);
    const command = normalizeRequired(rawNode.command, 'command', 'EXECUTION_COMMAND_REQUIRED', 20_000);
    const cwdInput = normalizeRequired(rawNode.cwd, 'cwd', 'EXECUTION_CWD_REQUIRED', 5_000);
    if (hasInlineSecret(command)) {
      fail('EXECUTION_INLINE_SECRET', `Node ${id} contains obvious inline secret material; use an environment or file reference`);
    }
    try {
      assertCommandAllowed(command);
    } catch (error) {
      fail('EXECUTION_COMMAND_BLOCKED', error instanceof Error ? error.message : String(error));
    }
    if (!options.workspace.isAllowed(cwdInput)) {
      fail('EXECUTION_CWD_OUTSIDE_ROOT', `Node ${id} cwd is outside allowed roots`);
    }
    let cwd: string;
    try {
      let resolvedCwd = resolvedCwds.get(cwdInput);
      if (!resolvedCwd) {
        resolvedCwd = options.workspace.resolveExisting(cwdInput);
        resolvedCwds.set(cwdInput, resolvedCwd);
      }
      cwd = await resolvedCwd;
    } catch {
      fail('EXECUTION_CWD_OUTSIDE_ROOT', `Node ${id} cwd is missing or escapes allowed roots`);
    }

    const dependsOn = normalizeDependencyIds(rawNode.dependsOn, id);
    const timeoutMs = rawNode.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      fail('EXECUTION_TIMEOUT_INVALID', `Node ${id} timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    }
    if (rawNode.continueOnFailure !== undefined && typeof rawNode.continueOnFailure !== 'boolean') {
      fail('EXECUTION_CONTINUE_ON_FAILURE_INVALID', `Node ${id} continueOnFailure must be boolean`);
    }
    const expectedArtifacts = await normalizeExpectedArtifacts(rawNode.expectedArtifacts, id, cwd, options.workspace);
    normalized.push({
      id,
      purpose,
      command,
      cwd,
      dependsOn,
      timeoutMs,
      continueOnFailure: rawNode.continueOnFailure ?? false,
      expectedArtifacts,
    });
  }

  const byId = new Map(normalized.map((item) => [item.id, item]));
  for (const item of normalized) {
    for (const dependencyId of item.dependsOn) {
      if (!byId.has(dependencyId)) {
        fail('EXECUTION_DEPENDENCY_MISSING', `Node ${item.id} depends on missing node ${dependencyId}`);
      }
    }
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const item of normalized) {
    inDegree.set(item.id, item.dependsOn.length);
    for (const dependencyId of item.dependsOn) {
      const targets = dependents.get(dependencyId) ?? [];
      targets.push(item.id);
      dependents.set(dependencyId, targets);
    }
  }
  for (const targets of dependents.values()) targets.sort((left, right) => left.localeCompare(right));

  const available = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([id]) => id)
    .sort((left, right) => left.localeCompare(right));
  const topologicalOrder: string[] = [];
  while (available.length > 0) {
    const id = available.shift()!;
    topologicalOrder.push(id);
    for (const target of dependents.get(id) ?? []) {
      const next = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, next);
      if (next === 0) {
        available.push(target);
        available.sort((left, right) => left.localeCompare(right));
      }
    }
  }
  if (topologicalOrder.length !== normalized.length) {
    fail('EXECUTION_DAG_CYCLE', 'Execution DAG contains a dependency cycle');
  }

  const orderedNodes = topologicalOrder.map((id) => byId.get(id)!);
  return {
    nodes: orderedNodes,
    nodeById: new Map(orderedNodes.map((item) => [item.id, item])),
    topologicalOrder,
  };
}

export function readyNodes(
  graph: ExecutionDag,
  states: Readonly<Record<string, ExecutionNodeState>>,
): ValidatedExecutionNode[] {
  return graph.topologicalOrder
    .map((id) => graph.nodeById.get(id)!)
    .filter((item) => {
      const state = states[item.id] ?? 'queued';
      if (state !== 'queued' && state !== 'ready') return false;
      return item.dependsOn.every((dependencyId) => states[dependencyId] === 'succeeded');
    });
}
