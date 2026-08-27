import { describe, expect, it } from 'vitest';
import { BRIDGE_NAME, BRIDGE_VERSION, sanitizeEnvironment } from '../src/constants.js';
import { CodespaceError, errorPayload } from '../src/errors.js';

describe('bridge contract', () => {
  it('uses the required identity and strips tunnel credentials', () => {
    expect(BRIDGE_NAME).toBe('codespace');
    expect(BRIDGE_VERSION).toBe('0.1.0');

    const env = sanitizeEnvironment({
      KEEP_ME: 'yes',
      CONTROL_PLANE_API_KEY: 'secret-value',
      OPENAI_ADMIN_KEY: 'admin-value',
    });

    expect(env.KEEP_ME).toBe('yes');
    expect(env.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(env.OPENAI_ADMIN_KEY).toBeUndefined();
  });

  it('returns stable structured errors without stack traces', () => {
    const payload = errorPayload(new CodespaceError('SAMPLE_ERROR', 'safe message', { sample: true }));
    expect(payload).toEqual({
      error: {
        code: 'SAMPLE_ERROR',
        message: 'safe message',
        details: { sample: true },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('stack');
  });
});
