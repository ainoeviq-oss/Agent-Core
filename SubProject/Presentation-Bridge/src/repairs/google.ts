import { BridgeError, ErrorCode } from '../security/errors.js';
import { GoogleRestClient } from '../converters/google/rest.js';

export type GoogleRepairOperation =
  | { kind: 'replace_all_text'; find: string; replace: string; matchCase?: boolean }
  | { kind: 'delete_object'; objectId: string };

export function parseGoogleRepairOperation(value: unknown): GoogleRepairOperation {
  if (!value || typeof value !== 'object') throw new BridgeError(ErrorCode.GOOGLE_REPAIR_REJECTED, 'Repair operation must be an object.');
  const v = value as Record<string, unknown>;
  if (v.kind === 'replace_all_text' && typeof v.find === 'string' && v.find && typeof v.replace === 'string' && (v.matchCase === undefined || typeof v.matchCase === 'boolean')) {
    return { kind: 'replace_all_text', find: v.find, replace: v.replace, ...(typeof v.matchCase === 'boolean' ? { matchCase: v.matchCase } : {}) };
  }
  if (v.kind === 'delete_object' && typeof v.objectId === 'string' && v.objectId) return { kind: 'delete_object', objectId: v.objectId };
  throw new BridgeError(ErrorCode.GOOGLE_REPAIR_REJECTED, 'Repair operation is not in the bounded allowlist.', { kind: v.kind });
}

export async function applyBoundedGoogleRepairs(client: GoogleRestClient, presentationId: string, operations: GoogleRepairOperation[]): Promise<{ applied: number }> {
  if (operations.length > 100) throw new BridgeError(ErrorCode.GOOGLE_REPAIR_REJECTED, 'Repair batch exceeds bounded operation limit of 100.');
  const requests = operations.map(parseGoogleRepairOperation).map((operation) => operation.kind === 'replace_all_text'
    ? { replaceAllText: { containsText: { text: operation.find, matchCase: operation.matchCase ?? true }, replaceText: operation.replace } }
    : { deleteObject: { objectId: operation.objectId } });
  if (requests.length === 0) return { applied: 0 };
  await client.batchUpdate(presentationId, requests);
  return { applied: requests.length };
}
