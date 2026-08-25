export interface NormalizedMemoryText {
  canonical: string;
  search: string;
}

export function normalizeMemoryText(input: string): NormalizedMemoryText {
  const canonical = input
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();

  return {
    canonical,
    search: canonical.toLowerCase(),
  };
}

export function normalizeCanonicalKey(input: string): string {
  return normalizeMemoryText(input).search;
}
