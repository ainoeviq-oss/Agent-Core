import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Vitest discovery boundaries', () => {
  it('excludes root-level stable release artifacts and allows bounded headroom for parallel integration tests', async () => {
    const config = await readFile(path.resolve('vitest.config.ts'), 'utf8');
    expect(config).toContain("'**/stable-release/**'");
    expect(config).toContain("'**/SubProject/**'");
    expect(config).toContain('testTimeout: 15_000');
  });
});
