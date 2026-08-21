const baseUrl = process.env.COMMANDER_SMOKE_URL ?? 'http://127.0.0.1:8765';
const key = process.env.COMMANDER_SMOKE_KEY;
const expectedKeyId = process.env.COMMANDER_SMOKE_KEY_ID;
const mode = process.argv[2] ?? 'live';

if (!key) throw new Error('COMMANDER_SMOKE_KEY is required');

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
    clientInfo: { name: 'commander-smoke', version: '1.0.0' },
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
assert(initialized.json?.result?.serverInfo?.name === 'desktop-commander', 'unexpected MCP server identity');

const tools = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const toolNames = tools.json?.result?.tools?.map((tool) => tool.name) ?? [];
assert(JSON.stringify(toolNames) === JSON.stringify(['commander_status', 'commander_capabilities']), 'unexpected tool list');

const status = await postMcp({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'commander_status', arguments: {} },
});
assert(status.response.status === 200, 'commander_status failed');
assert(status.json?.result?.structuredContent?.authentication === 'bearer-api-key', 'status auth mismatch');
if (expectedKeyId) {
  assert(status.json?.result?.structuredContent?.key?.id === expectedKeyId, 'status key identity mismatch');
}

const capabilities = await postMcp({
  jsonrpc: '2.0', id: 4, method: 'tools/call',
  params: { name: 'commander_capabilities', arguments: {} },
});
assert(capabilities.response.status === 200, 'commander_capabilities failed');
assert(capabilities.json?.result?.structuredContent?.enabled?.includes('auth.api_key'), 'capability auth.api_key missing');

console.log(JSON.stringify({
  health: health.status,
  unauthorized: unauthorized.response.status,
  initialized: initialized.json.result.serverInfo,
  tools: toolNames,
  statusKeyId: status.json.result.structuredContent.key.id,
  capabilitiesStage: capabilities.json.result.structuredContent.stage,
}));
