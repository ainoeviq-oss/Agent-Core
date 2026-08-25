import { describe, expect, it } from 'vitest';
import { redactMemoryText } from '../src/memory/redaction.js';

describe('memory secret redaction', () => {
  it('redacts common secret forms before persistence or indexing', () => {
    const input = [
      'Authorization: Bearer sk_live_abcdefghijklmnopqrstuvwxyz123456',
      'api_key=abcDEF1234567890SUPERSECRET',
      'password: My-Private-Password-123!',
      'token: ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'normal text remains visible',
    ].join('\n');
    const result = redactMemoryText(input);
    expect(result.text).toContain('[REDACTED:BEARER]');
    expect(result.text).toContain('[REDACTED:API_KEY]');
    expect(result.text).toContain('[REDACTED:PASSWORD]');
    expect(result.text).toContain('[REDACTED:TOKEN]');
    expect(result.text).toContain('normal text remains visible');
    for (const secret of ['sk_live_abcdefghijklmnopqrstuvwxyz123456', 'abcDEF1234567890SUPERSECRET', 'My-Private-Password-123!', 'ghp_abcdefghijklmnopqrstuvwxyz1234567890']) {
      expect(result.text).not.toContain(secret);
    }
    expect(result.redactionCount).toBe(4);
  });
});
