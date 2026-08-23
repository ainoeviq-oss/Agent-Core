const baseUrl = process.env.AGENT_CORE_SMOKE_URL ?? 'http://127.0.0.1:8765';
const key = process.env.AGENT_CORE_SMOKE_KEY;
const expectedKeyId = process.env.AGENT_CORE_SMOKE_KEY_ID;
const mode = process.argv[2] ?? 'live';

if (!key) throw new Error('AGENT_CORE_SMOKE_KEY is required');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function postMcp(body, token = key) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'agent-core-smoke', version: '1.0.0' },
  },
};

if (mode === 'revoked') {
  const revoked = await postMcp(initializeBody);
  assert(revoked.response.status === 401, `expected revoked key 401, got ${revoked.response.status}`);
  console.log(JSON.stringify({ revokedRejected: true, status: revoked.response.status }));
  process.exit(0);
}

const health = await fetch(`${baseUrl}/health`);
assert(health.status === 200, `health expected 200, got ${health.status}`);
const healthJson = await health.json();
assert(healthJson.status === 'ok', 'health payload did not report ok');

const unauthorized = await postMcp(initializeBody, null);
assert(unauthorized.response.status === 401, `unauthorized expected 401, got ${unauthorized.response.status}`);

const initialized = await postMcp(initializeBody);
assert(initialized.response.status === 200, `initialize expected 200, got ${initialized.response.status}`);
assert(initialized.json?.result?.serverInfo?.name === 'agent-core', 'unexpected MCP server identity');

const tools = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const toolNames = tools.json?.result?.tools?.map((tool) => tool.name) ?? [];
assert(toolNames.length === 23, `expected 23 tools, got ${toolNames.length}`);
assert(toolNames.includes('agent_core_status'), 'agent_core_status missing');
assert(toolNames.includes('agent_core_capabilities'), 'agent_core_capabilities missing');
assert(toolNames.includes('capability_coverage'), 'capability_coverage missing');
assert(toolNames.includes('skill_load'), 'skill_load missing');

const status = await postMcp({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'agent_core_status', arguments: {} },
});
assert(status.response.status === 200, 'agent_core_status failed');
assert(status.json?.result?.structuredContent?.authentication === 'bearer-api-key', 'status auth mismatch');
if (expectedKeyId) {
  assert(status.json?.result?.structuredContent?.key?.id === expectedKeyId, 'status key identity mismatch');
}

const capabilities = await postMcp({
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'agent_core_capabilities', arguments: {} },
});
assert(capabilities.response.status === 200, 'agent_core_capabilities failed');
assert(capabilities.json?.result?.structuredContent?.enabled?.includes('auth.api_key'), 'capability auth.api_key missing');

const coverageCall = await postMcp({
  jsonrpc: '2.0', id: 5, method: 'tools/call',
  params: { name: 'capability_coverage', arguments: {} },
});
const coverage = JSON.parse(coverageCall.json.result.content[0].text);
assert(coverage.total > 0, 'capability registry is empty');

const nativeSearch = await postMcp({
  jsonrpc: '2.0', id: 6, method: 'tools/call',
  params: { name: 'capability_search', arguments: { query: '', state: 'native_ready', limit: 1 } },
});
const nativeResults = JSON.parse(nativeSearch.json.result.content[0].text).results ?? [];
let loadedSkill = null;
if (nativeResults.length) {
  const loaded = await postMcp({
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'skill_load', arguments: { id: nativeResults[0].id } },
  });
  assert(loaded.json?.result?.isError !== true, 'native-ready skill_load failed');
  loadedSkill = nativeResults[0].name;
}

console.log(JSON.stringify({
  health: health.status,
  unauthorized: unauthorized.response.status,
  initialized: initialized.json.result.serverInfo,
  tools: toolNames,
  statusKeyId: status.json.result.structuredContent.key.id,
  capabilitiesStage: capabilities.json.result.structuredContent.stage,
  coverageTotal: coverage.total,
  nativeReady: coverage.nativeReady,
  loadedSkill,
}));
