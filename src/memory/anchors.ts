import { containsRedactionMarker } from './redaction.js';

export type MemoryAnchorType =
  | 'windows_path'
  | 'unix_path'
  | 'uuid'
  | 'capability_id'
  | 'tool_id'
  | 'url'
  | 'key_value'
  | 'route_id'
  | 'process_id'
  | 'run_id';

export interface MemoryAnchor {
  type: MemoryAnchorType;
  value: string;
}

function pushAnchor(target: Map<string, MemoryAnchor>, type: MemoryAnchorType, rawValue: string): void {
  const value = rawValue.trim().replace(/[),.;!?]+$/u, '');
  if (!value || containsRedactionMarker(value) || /REDACTED/i.test(value)) return;
  target.set(`${type}\0${value}`, { type, value });
}

function eachMatch(text: string, pattern: RegExp, handler: (match: RegExpExecArray) => void): void {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    handler(match);
    if (match[0] === '') pattern.lastIndex += 1;
  }
}

export function extractMemoryAnchors(input: string): MemoryAnchor[] {
  const text = input.normalize('NFKC');
  const anchors = new Map<string, MemoryAnchor>();

  eachMatch(text, /["']([A-Za-z]:\\[^"'\r\n]+)["']/g, (match) => pushAnchor(anchors, 'windows_path', match[1]!));
  eachMatch(text, /(?:^|\s)([A-Za-z]:\\[^\s,;]+(?:\\[^\s,;]+)*)/g, (match) => pushAnchor(anchors, 'windows_path', match[1]!));
  eachMatch(text, /(?:^|[\s"'(])((?:\/[A-Za-z0-9._-]+){2,})(?=[\s"'),;.!?]|$)/g, (match) => pushAnchor(anchors, 'unix_path', match[1]!));
  eachMatch(text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, (match) => pushAnchor(anchors, 'uuid', match[0].toLowerCase()));
  eachMatch(text, /\bcap_[a-z0-9]{12,}\b/gi, (match) => pushAnchor(anchors, 'capability_id', match[0]));
  eachMatch(text, /\bproc_[a-z0-9-]{4,}\b/gi, (match) => pushAnchor(anchors, 'process_id', match[0]));
  eachMatch(text, /\brun_[a-z0-9-]{4,}\b/gi, (match) => pushAnchor(anchors, 'run_id', match[0]));
  eachMatch(text, /\broute_[a-z0-9-]{4,}\b/gi, (match) => pushAnchor(anchors, 'route_id', match[0]));
  eachMatch(text, /\bhttps?:\/\/[^\s<>"']+/gi, (match) => pushAnchor(anchors, 'url', match[0]));
  eachMatch(text, /\bagent_core_[a-z][a-z0-9_]*\b/g, (match) => pushAnchor(anchors, 'tool_id', match[0]));

  const blockedKeys = new Set(['authorization', 'password', 'passwd', 'pwd', 'token', 'api_key', 'apikey', 'client_secret', 'access_key', 'redacted']);
  eachMatch(text, /\b([A-Za-z][A-Za-z0-9_.-]{1,40}):([^\s,;]+)/g, (match) => {
    const key = match[1]!.toLowerCase();
    if (blockedKeys.has(key) || key === 'http' || key === 'https') return;
    pushAnchor(anchors, 'key_value', `${match[1]}:${match[2]}`);
  });

  return [...anchors.values()].sort((a, b) => `${a.type}\0${a.value}`.localeCompare(`${b.type}\0${b.value}`));
}
