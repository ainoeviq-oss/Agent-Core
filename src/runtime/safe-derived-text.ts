import { redactMemoryText } from '../memory/redaction.js';

export function safeDerivedText(value: string, maxChars = 240): string {
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const redacted = redactMemoryText(normalized).text;
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
