export function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

export function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`(?:^|\\s)${name.replace(':', '\\:')}="([^"]*)"`, 'i'));
  return match?.[1] ? decodeXml(match[1]) : undefined;
}

export function tags(xml: string, qualifiedName: string): string[] {
  return [...xml.matchAll(new RegExp(`<${qualifiedName}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

export function countTag(xml: string, qualifiedName: string): number {
  return (xml.match(new RegExp(`<${qualifiedName}\\b`, 'gi')) ?? []).length;
}

export function textRuns(xml: string): string[] {
  return [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
    .map((match) => decodeXml(match[1] ?? '').trim())
    .filter(Boolean);
}

export function typefaces(xml: string): string[] {
  return [...xml.matchAll(/\btypeface="([^"]+)"/gi)]
    .map((match) => decodeXml(match[1] ?? '').trim())
    .filter((name) => name && !name.startsWith('+'));
}
