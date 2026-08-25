import { describe, expect, it } from 'vitest';
import { normalizeMemoryText } from '../src/memory/normalizer.js';

describe('memory text normalization', () => {
  it('uses Unicode NFKC, stable whitespace and a lower-case search projection', () => {
    const result = normalizeMemoryText('  Proyek\u3000Ａgent   CORE\n\tKeputusan:  F:\\Projects\\Agent-Core  ');
    expect(result.canonical).toBe('Proyek Agent CORE Keputusan: F:\\Projects\\Agent-Core');
    expect(result.search).toBe('proyek agent core keputusan: f:\\projects\\agent-core');
  });

  it('preserves Indonesian and English punctuation while stabilizing whitespace', () => {
    const result = normalizeMemoryText('Jangan hapus bukti; keep audit logs!   Status: ACTIVE.');
    expect(result.canonical).toBe('Jangan hapus bukti; keep audit logs! Status: ACTIVE.');
    expect(result.search).toBe('jangan hapus bukti; keep audit logs! status: active.');
  });
});
