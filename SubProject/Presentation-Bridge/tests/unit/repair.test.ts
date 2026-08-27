import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleRepairOperation } from '../../src/repairs/google.js';
import { BridgeError } from '../../src/security/errors.js';

test('bounded repair allowlist accepts explicit operations', () => {
  assert.deepEqual(parseGoogleRepairOperation({ kind: 'replace_all_text', find: 'A', replace: 'B' }), { kind: 'replace_all_text', find: 'A', replace: 'B' });
  assert.deepEqual(parseGoogleRepairOperation({ kind: 'delete_object', objectId: 'shape_1' }), { kind: 'delete_object', objectId: 'shape_1' });
});

test('bounded repair rejects arbitrary Google API payloads', () => {
  assert.throws(() => parseGoogleRepairOperation({ kind: 'raw_batch_update', requests: [{ deleteSlide: {} }] }), BridgeError);
});
