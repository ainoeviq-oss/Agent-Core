import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { auditSourceIsolation } from '../../src/security/isolation.js';
import { keynoteDoctor } from '../../src/workers/keynote/doctor.js';

test('source code is isolated from forbidden project coupling', async () => {
  const audit = await auditSourceIsolation(resolve('.'));
  assert.equal(audit.clean,true,JSON.stringify(audit.findings));
});

test('Keynote doctor never claims availability on non-macOS', async () => {
  const doctor = await keynoteDoctor();
  if (process.platform !== 'darwin') assert.equal(doctor.available,false);
});
