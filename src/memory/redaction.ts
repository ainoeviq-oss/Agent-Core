export interface MemoryRedactionResult {
  text: string;
  redactionCount: number;
  categories: string[];
}

type RedactionRule = {
  category: string;
  pattern: RegExp;
};

const RULES: RedactionRule[] = [
  {
    category: 'BEARER',
    pattern: /\bAuthorization\s*:\s*Bearer\s+[^\s,;]+|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi,
  },
  {
    category: 'API_KEY',
    pattern: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  },
  {
    category: 'PASSWORD',
    pattern: /\b(?:password|passwd|pwd)\s*[:=]\s*[^\s,;]+/gi,
  },
  {
    category: 'TOKEN',
    pattern: /\b(?:token|refresh[_-]?token|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi,
  },
];

export function redactMemoryText(input: string): MemoryRedactionResult {
  let text = input;
  let redactionCount = 0;
  const categories = new Set<string>();

  for (const rule of RULES) {
    text = text.replace(rule.pattern, () => {
      redactionCount += 1;
      categories.add(rule.category);
      return `[REDACTED:${rule.category}]`;
    });
  }

  return {
    text,
    redactionCount,
    categories: [...categories].sort(),
  };
}

export function containsRedactionMarker(value: string): boolean {
  return /\[REDACTED:[A-Z_]+\]/i.test(value);
}
