export const CONTINUITY_TURN_STATES = ['open', 'closed', 'interrupted'] as const;
export const CONTINUITY_TASK_STATUSES = [
  'planned', 'ready', 'running', 'blocked', 'deferred',
  'completed', 'failed', 'cancelled', 'interrupted',
] as const;
export const FRONTIER_STATUSES = ['candidate', 'approved', 'deferred', 'dismissed', 'completed'] as const;

export type ContinuityTurnState = (typeof CONTINUITY_TURN_STATES)[number];
export type ContinuityTaskStatus = (typeof CONTINUITY_TASK_STATUSES)[number];
export type FrontierStatus = (typeof FRONTIER_STATUSES)[number];

export interface ContinuityCapture {
  objective?: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  parentTaskId?: string;
  resumeTaskId?: string;
}

export type ContinuityEvidenceType = 'tool' | 'file' | 'test' | 'log' | 'hash' | 'health';

export interface ContinuityCheckpointInput {
  routeContextId: string;
  status: Exclude<ContinuityTaskStatus, 'planned' | 'ready'>;
  summary: string;
  evidence?: Array<{ type: ContinuityEvidenceType; ref: string; result?: string }>;
  decisions?: Array<{ key: string; value: string; reason: string }>;
  artifacts?: Array<{ path: string; role: string; hash?: string }>;
  blockers?: Array<{ code: string; detail: string }>;
  deferred?: Array<{ title: string; reason: string }>;
  nextCandidates?: Array<{ title: string; rationale: string; dependsOnTaskIds?: string[]; priority?: number }>;
  projectTerminal?: boolean;
}

export const CONTINUITY_LIMITS = {
  textChars: 20_000,
  shortTextChars: 5_000,
  acceptanceCriteria: 50,
  constraints: 50,
  evidence: 100,
  decisions: 100,
  artifacts: 100,
  blockers: 100,
  deferred: 100,
  nextCandidates: 5,
  dependencyIds: 128,
} as const;

export class ContinuityContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ContinuityContractError';
  }
}

const TERMINAL_TASK_STATUSES = new Set<ContinuityTaskStatus>(['completed', 'failed', 'cancelled']);
const CHECKPOINT_TASK_STATUSES = new Set<ContinuityTaskStatus>([
  'running', 'blocked', 'deferred', 'completed', 'failed', 'cancelled', 'interrupted',
]);
const EVIDENCE_TYPES = new Set<ContinuityEvidenceType>(['tool', 'file', 'test', 'log', 'hash', 'health']);

function contractError(code: string, message: string): never {
  throw new ContinuityContractError(code, message);
}

function normalizeText(
  value: unknown,
  field: string,
  options: { required?: boolean; maxChars?: number } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) contractError('CONTINUITY_TEXT_REQUIRED', `${field} is required`);
    return undefined;
  }
  if (typeof value !== 'string') contractError('CONTINUITY_TEXT_INVALID', `${field} must be text`);
  const normalized = value.normalize('NFKC').trim();
  if (!normalized) {
    if (options.required) contractError('CONTINUITY_TEXT_REQUIRED', `${field} is required`);
    return undefined;
  }
  const maxChars = options.maxChars ?? CONTINUITY_LIMITS.textChars;
  if (normalized.length > maxChars) {
    contractError('CONTINUITY_TEXT_TOO_LONG', `${field} exceeds ${maxChars} characters`);
  }
  return normalized;
}

function assertList(value: unknown, field: string, limit: number): unknown[] {
  if (!Array.isArray(value)) contractError('CONTINUITY_LIST_INVALID', `${field} must be an array`);
  if (value.length > limit) contractError('CONTINUITY_LIST_LIMIT', `${field} exceeds ${limit} items`);
  return value;
}

function normalizeStringList(value: unknown, field: string, limit: number): string[] {
  const values = assertList(value, field, limit);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of values) {
    const normalized = normalizeText(item, `${field}[]`, { maxChars: CONTINUITY_LIMITS.textChars });
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeShortRequired(value: unknown, field: string): string {
  return normalizeText(value, field, { required: true, maxChars: CONTINUITY_LIMITS.shortTextChars })!;
}

function normalizeLongRequired(value: unknown, field: string): string {
  return normalizeText(value, field, { required: true, maxChars: CONTINUITY_LIMITS.textChars })!;
}

function normalizeOptionalShort(value: unknown, field: string): string | undefined {
  return normalizeText(value, field, { maxChars: CONTINUITY_LIMITS.shortTextChars });
}

export function isTerminalContinuityTaskStatus(status: ContinuityTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}

export function normalizeContinuityCapture(input: ContinuityCapture): ContinuityCapture {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    contractError('CONTINUITY_CAPTURE_INVALID', 'continuity capture must be an object');
  }
  const output: ContinuityCapture = {};
  const objective = normalizeText(input.objective, 'objective');
  if (objective !== undefined) output.objective = objective;
  if (input.acceptanceCriteria !== undefined) {
    output.acceptanceCriteria = normalizeStringList(
      input.acceptanceCriteria, 'acceptanceCriteria', CONTINUITY_LIMITS.acceptanceCriteria,
    );
  }
  if (input.constraints !== undefined) {
    output.constraints = normalizeStringList(input.constraints, 'constraints', CONTINUITY_LIMITS.constraints);
  }
  const parentTaskId = normalizeOptionalShort(input.parentTaskId, 'parentTaskId');
  if (parentTaskId !== undefined) output.parentTaskId = parentTaskId;
  const resumeTaskId = normalizeOptionalShort(input.resumeTaskId, 'resumeTaskId');
  if (resumeTaskId !== undefined) output.resumeTaskId = resumeTaskId;
  return output;
}

export function normalizeContinuityCheckpointInput(input: ContinuityCheckpointInput): ContinuityCheckpointInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    contractError('CONTINUITY_CHECKPOINT_INVALID', 'continuity checkpoint must be an object');
  }
  if (!CHECKPOINT_TASK_STATUSES.has(input.status as ContinuityTaskStatus)) {
    contractError('CONTINUITY_STATUS_INVALID', `status is not valid for a checkpoint: ${String(input.status)}`);
  }

  const output: ContinuityCheckpointInput = {
    routeContextId: normalizeShortRequired(input.routeContextId, 'routeContextId'),
    status: input.status,
    summary: normalizeLongRequired(input.summary, 'summary'),
  };

  if (input.evidence !== undefined) {
    output.evidence = assertList(input.evidence, 'evidence', CONTINUITY_LIMITS.evidence).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        contractError('CONTINUITY_ITEM_INVALID', `evidence[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      if (typeof item.type !== 'string' || !EVIDENCE_TYPES.has(item.type as ContinuityEvidenceType)) {
        contractError('CONTINUITY_EVIDENCE_TYPE_INVALID', `evidence[${index}].type is invalid`);
      }
      const result = normalizeText(item.result, `evidence[${index}].result`);
      return {
        type: item.type as ContinuityEvidenceType,
        ref: normalizeShortRequired(item.ref, `evidence[${index}].ref`),
        ...(result === undefined ? {} : { result }),
      };
    });
  }

  if (input.decisions !== undefined) {
    output.decisions = assertList(input.decisions, 'decisions', CONTINUITY_LIMITS.decisions).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        contractError('CONTINUITY_ITEM_INVALID', `decisions[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      return {
        key: normalizeShortRequired(item.key, `decisions[${index}].key`),
        value: normalizeLongRequired(item.value, `decisions[${index}].value`),
        reason: normalizeLongRequired(item.reason, `decisions[${index}].reason`),
      };
    });
  }

  if (input.artifacts !== undefined) {
    output.artifacts = assertList(input.artifacts, 'artifacts', CONTINUITY_LIMITS.artifacts).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        contractError('CONTINUITY_ITEM_INVALID', `artifacts[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      const hash = normalizeOptionalShort(item.hash, `artifacts[${index}].hash`);
      return {
        path: normalizeShortRequired(item.path, `artifacts[${index}].path`),
        role: normalizeShortRequired(item.role, `artifacts[${index}].role`),
        ...(hash === undefined ? {} : { hash }),
      };
    });
  }

  if (input.blockers !== undefined) {
    output.blockers = assertList(input.blockers, 'blockers', CONTINUITY_LIMITS.blockers).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        contractError('CONTINUITY_ITEM_INVALID', `blockers[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      return {
        code: normalizeShortRequired(item.code, `blockers[${index}].code`),
        detail: normalizeLongRequired(item.detail, `blockers[${index}].detail`),
      };
    });
  }

  if (input.deferred !== undefined) {
    output.deferred = assertList(input.deferred, 'deferred', CONTINUITY_LIMITS.deferred).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        contractError('CONTINUITY_ITEM_INVALID', `deferred[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      return {
        title: normalizeShortRequired(item.title, `deferred[${index}].title`),
        reason: normalizeLongRequired(item.reason, `deferred[${index}].reason`),
      };
    });
  }

  if (input.nextCandidates !== undefined) {
    output.nextCandidates = assertList(
      input.nextCandidates, 'nextCandidates', CONTINUITY_LIMITS.nextCandidates,
    ).map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        contractError('CONTINUITY_ITEM_INVALID', `nextCandidates[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      let dependsOnTaskIds: string[] | undefined;
      if (item.dependsOnTaskIds !== undefined) {
        dependsOnTaskIds = normalizeStringList(
          item.dependsOnTaskIds,
          `nextCandidates[${index}].dependsOnTaskIds`,
          CONTINUITY_LIMITS.dependencyIds,
        );
      }
      let priority: number | undefined;
      if (item.priority !== undefined) {
        if (typeof item.priority !== 'number' || !Number.isFinite(item.priority)) {
          contractError('CONTINUITY_PRIORITY_INVALID', `nextCandidates[${index}].priority must be finite`);
        }
        priority = item.priority;
      }
      return {
        title: normalizeShortRequired(item.title, `nextCandidates[${index}].title`),
        rationale: normalizeLongRequired(item.rationale, `nextCandidates[${index}].rationale`),
        ...(dependsOnTaskIds === undefined ? {} : { dependsOnTaskIds }),
        ...(priority === undefined ? {} : { priority }),
      };
    });
  }

  if (input.projectTerminal !== undefined) {
    if (typeof input.projectTerminal !== 'boolean') {
      contractError('CONTINUITY_PROJECT_TERMINAL_INVALID', 'projectTerminal must be boolean');
    }
    output.projectTerminal = input.projectTerminal;
  }

  if (isTerminalContinuityTaskStatus(output.status) && !output.projectTerminal) {
    const candidateCount = output.nextCandidates?.length ?? 0;
    if (candidateCount < 2) {
      contractError('CONTINUITY_FRONTIER_REQUIRED', 'terminal task requires 2-5 next candidates unless projectTerminal=true');
    }
  }

  return output;
}
