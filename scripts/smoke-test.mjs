import { randomUUID } from 'node:crypto';
import path from 'node:path';

const baseUrl = process.env.AGENT_CORE_SMOKE_URL ?? 'http://127.0.0.1:8765';
const key = process.env.AGENT_CORE_SMOKE_KEY;
const expectedKeyId = process.env.AGENT_CORE_SMOKE_KEY_ID;
const mode = process.argv[2] ?? 'live';
const GATED_TOOLS = [
  'list_directory', 'read_file', 'read_multiple_files', 'write_file', 'edit_file',
  'create_directory', 'move_file', 'get_file_info', 'search_files', 'execute_command',
  'start_process',
];

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
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, json: text ? JSON.parse(text) : null };
}
function callTool(id, name, args = {}) {
  return postMcp({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name, arguments: args },
  });
}

function parseToolBody(result) {
  return JSON.parse(result.json.result.content[0].text);
}

const initializeBody = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2025-11-25', capabilities: {},
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
assert(initialized.json?.result?.serverInfo?.version === '0.5.0', 'unexpected MCP server version');

const tools = await postMcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const listedTools = tools.json?.result?.tools ?? [];
const toolNames = listedTools.map((tool) => tool.name);
assert(toolNames.length === 23, `expected 23 tools, got ${toolNames.length}`);
assert(toolNames.includes('capability_route'), 'capability_route missing');
assert(!toolNames.includes('capability_recommend'), 'capability_recommend must be absent');
assert(toolNames.includes('capability_coverage'), 'capability_coverage missing');
assert(toolNames.includes('skill_load'), 'skill_load missing');
for (const name of GATED_TOOLS) {
  const tool = listedTools.find((entry) => entry.name === name);
  assert(tool, `${name} missing`);
  assert((tool.inputSchema?.required ?? []).includes('routeContextId'), `${name} routeContextId not required`);
}

const status = await callTool(3, 'agent_core_status');
assert(status.response.status === 200, 'agent_core_status failed');
assert(status.json?.result?.structuredContent?.authentication === 'bearer-api-key', 'status auth mismatch');
if (expectedKeyId) {
  assert(status.json?.result?.structuredContent?.key?.id === expectedKeyId, 'status key identity mismatch');
}
const capabilities = await callTool(4, 'agent_core_capabilities');
assert(capabilities.response.status === 200, 'agent_core_capabilities failed');
assert(capabilities.json?.result?.structuredContent?.stage === 'v4-automatic-capability-routing', 'routing stage mismatch');
assert(capabilities.json?.result?.structuredContent?.enabled?.includes('routing.execution_gate'), 'routing execution gate marker missing');

const coverageCall = await callTool(5, 'capability_coverage');
const coverage = parseToolBody(coverageCall);
assert(coverage.total > 0, 'capability registry is empty');

const workspace = await callTool(6, 'workspace_info');
const workspaceBody = parseToolBody(workspace);
const workspaceRoot = workspaceBody.roots?.[0];
assert(typeof workspaceRoot === 'string' && workspaceRoot.length > 0, 'workspace root missing');

const atomicCall = await callTool(7, 'capability_route', {
  task: 'Create a small proof file',
  context: `Workspace root is ${workspaceRoot}`,
});
const atomicRoute = parseToolBody(atomicCall);
assert(atomicRoute.mode === 'atomic_direct', `expected atomic_direct, got ${atomicRoute.mode}`);
assert((atomicRoute.requiredSkillLoads ?? []).length === 0, 'atomic route unexpectedly requires a skill');
assert(typeof atomicRoute.routeContextId === 'string', 'atomic routeContextId missing');

const proofPath = path.join(workspaceRoot, 'route-proof.txt');
const proofWrite = await callTool(8, 'write_file', {
  path: proofPath,
  content: 'Agent Core automatic routing works',
  routeContextId: atomicRoute.routeContextId,
});
assert(proofWrite.json?.result?.isError !== true, 'route-bound proof write failed');
const proofRead = await callTool(9, 'read_file', {
  path: proofPath,
  routeContextId: atomicRoute.routeContextId,
});
assert(proofRead.json?.result?.isError !== true, 'route-bound proof read failed');
assert(proofRead.json.result.content[0].text.includes('Agent Core automatic routing works'), 'proof read-back mismatch');

const domainCall = await callTool(10, 'capability_route', {
  task: 'Improve a frontend dashboard visual hierarchy and spacing',
  context: `Workspace root is ${workspaceRoot}`,
});
const domainRoute = parseToolBody(domainCall);
const recommendations = domainRoute.recommendedCapabilities ?? [];
assert(recommendations.length > 0, 'frontend domain route returned no recommendations');
const frontendRelevant = recommendations.some((item) =>
  /frontend|visual|design|impeccable|ui|ux/i.test(`${item.name ?? ''} ${item.displayName ?? ''} ${item.category ?? ''}`),
);
assert(frontendRelevant, 'frontend domain route did not return a frontend-relevant capability');

const loadedSkills = [];
for (const required of domainRoute.requiredSkillLoads ?? []) {
  const loaded = await callTool(11 + loadedSkills.length, 'skill_load', {
    id: required.id,
    routeContextId: domainRoute.routeContextId,
  });
  assert(loaded.json?.result?.isError !== true, `route-aware skill_load failed for ${required.id}`);
  loadedSkills.push(required.id);
}

const harmless = await callTool(20, 'list_directory', {
  path: workspaceRoot, depth: 1, maxEntries: 20,
  routeContextId: domainRoute.routeContextId,
});
assert(harmless.json?.result?.isError !== true, 'domain route-bound harmless operation failed');
const bypassPath = path.join(workspaceRoot, `route-bypass-${randomUUID()}.txt`);
const bypass = await callTool(21, 'write_file', {
  path: bypassPath,
  content: 'must not be written',
  routeContextId: randomUUID(),
});
assert(bypass.json?.result?.isError === true, 'fabricated route UUID was not rejected');
const bypassError = parseToolBody(bypass);
assert(bypassError.error?.code === 'ROUTE_NOT_FOUND', `unexpected bypass error: ${bypassError.error?.code}`);

const bypassInfo = await callTool(22, 'get_file_info', {
  path: bypassPath,
  routeContextId: atomicRoute.routeContextId,
});
assert(bypassInfo.json?.result?.isError === true, 'bypass path unexpectedly exists after rejected write');

console.log(JSON.stringify({
  health: health.status,
  unauthorized: unauthorized.response.status,
  initialized: initialized.json.result.serverInfo,
  tools: toolNames,
  statusKeyId: status.json.result.structuredContent.key.id,
  capabilitiesStage: capabilities.json.result.structuredContent.stage,
  coverageTotal: coverage.total,
  nativeReady: coverage.nativeReady,
  atomic: { mode: atomicRoute.mode, routeContextId: atomicRoute.routeContextId, proofPath },
  domain: {
    tier: domainRoute.tier,
    mode: domainRoute.mode,
    recommended: recommendations.slice(0, 5).map((item) => item.name),
    loadedSkills,
  },
  bypassRejected: bypassError.error?.code,
}));