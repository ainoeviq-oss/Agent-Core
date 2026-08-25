import { describe, expect, it } from 'vitest';
import { extractMemoryAnchors } from '../src/memory/anchors.js';
import { redactMemoryText } from '../src/memory/redaction.js';

describe('deterministic memory anchors', () => {
  it('extracts stable unique paths, IDs, URLs, key:value anchors and route/process IDs', () => {
    const uuid = '7b3db062-b4b9-476b-902a-5991c17dcecc';
    const text = [
      'Workspace "F:\\Projects\\Agent Core\\Design Files" and /srv/agent-core/runtime/logs.',
      `Route ${uuid} repeats ${uuid}.`,
      'Capability cap_cc81393302b4c682dd2b71fb uses tool agent_core_status.',
      'See https://example.com/docs/path?q=memory.',
      'project:Market-Signal-Lab owner:AgentCore proc_1234abcd run_abcdef12 route_context:ctx-77',
    ].join(' ');

    const anchors = extractMemoryAnchors(text);
    const key = anchors.map((anchor) => `${anchor.type}:${anchor.value}`);
    expect(key).toContain('windows_path:F:\\Projects\\Agent Core\\Design Files');
    expect(key).toContain('unix_path:/srv/agent-core/runtime/logs');
    expect(key.filter((item) => item === `uuid:${uuid}`)).toHaveLength(1);
    expect(key).toContain('capability_id:cap_cc81393302b4c682dd2b71fb');
    expect(key).toContain('tool_id:agent_core_status');
    expect(key).toContain('url:https://example.com/docs/path?q=memory');
    expect(key).toContain('key_value:project:Market-Signal-Lab');
    expect(key).toContain('process_id:proc_1234abcd');
    expect(key).toContain('run_id:run_abcdef12');
    expect(anchors).toEqual([...anchors].sort((a, b) => `${a.type}\0${a.value}`.localeCompare(`${b.type}\0${b.value}`)));
  });

  it('never turns redacted secret tokens into searchable anchors', () => {
    const redacted = redactMemoryText('api_key=https://secret.example/token/abc123 password: route_steal_this');
    const anchors = extractMemoryAnchors(redacted.text);
    expect(anchors.some((anchor) => anchor.value.includes('secret.example'))).toBe(false);
    expect(anchors.some((anchor) => anchor.value.includes('route_steal_this'))).toBe(false);
    expect(anchors.some((anchor) => anchor.value.includes('[REDACTED'))).toBe(false);
  });
});
