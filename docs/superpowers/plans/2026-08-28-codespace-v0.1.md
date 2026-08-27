# Codespace v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private ChatGPT plugin named `codespace` that reaches the active GitHub Codespace through OpenAI Tunnel, launches a small MCP server over stdio, and gives ChatGPT bounded workspace filesystem, shell, and background-process control without a public Codespaces port or custom OAuth.

**Architecture:** `tunnel-client v0.0.13` is the only network-facing runtime. It maintains the outbound OpenAI Tunnel connection and starts the new `plugin/codespace` MCP server through `--mcp-command`. The MCP child resolves one `/workspaces/...` repository, constrains file/cwd access to that root, strips tunnel credentials from child processes, and exposes a deliberately small tool surface. Dev-container lifecycle hooks start/repair the tunnel runtime in parallel with existing repository lifecycle commands.

**Tech Stack:** Node.js 24+, TypeScript 7, `@modelcontextprotocol/sdk` 1.30.0, Zod 4.4.3, Vitest 4.1.11, Bash, OpenAI `tunnel-client` v0.0.13, GitHub Codespaces Dev Container lifecycle.

**Spec:** `docs/superpowers/specs/2026-08-28-codespace-v0.1-design.md`

## Global Constraints

- Plugin identity is exactly `codespace`.
- All new bridge implementation lives under `plugin/codespace/`, except the minimal `.devcontainer/devcontainer.json` lifecycle integration and root `.gitignore` entry.
- The bridge does not reuse source, runtime state, auth stores, gateway config, or startup contracts from the legacy plugin.
- Connection mode is OpenAI **Tunnel**, not **Server URL**.
- No custom OAuth, Cloudflare gateway, SSE endpoint, or public Codespaces port is part of the new bridge.
- MCP transport between `tunnel-client` and the new server is stdio.
- `CONTROL_PLANE_API_KEY` is consumed only by `tunnel-client`; the MCP server and every tool-spawned child process must have it removed from their environment.
- Workspace access is limited to one canonical root under `/workspaces`.
- `READY` is emitted only after MCP self-test plus managed-runtime `process_running`, `healthy`, and `ready` gates pass.
- `tunnel-client` is pinned to `v0.0.13`; release assets are checksum-verified before use.
- The initial tunnel ID is runtime configuration, not source-code identity. `ensure-running.sh` resolves it from `CODESPACE_TUNNEL_ID`, then `CONTROL_PLANE_TUNNEL_ID`, then ignored local runtime config. It must never silently create a remote tunnel.
- Existing dev-container lifecycle commands remain present. Object-form lifecycle commands are used so the existing lifecycle and the new `codespace` lifecycle execute independently in parallel.

---

## File Structure

Create:

```text
plugin/codespace/
├── package.json
├── tsconfig.json
├── src/
│   ├── constants.ts
│   ├── errors.ts
│   ├── workspace.ts
│   ├── filesystem.ts
│   ├── commands.ts
│   ├── processes.ts
│   └── server.ts
├── scripts/
│   ├── install-tunnel-client.sh
│   ├── start-mcp.sh
│   ├── configure-tunnel.sh
│   ├── ensure-running.sh
│   └── verify.sh
├── config/
│   └── tunnel.defaults.json
└── tests/
    ├── workspace.test.ts
    ├── filesystem.test.ts
    ├── commands.test.ts
    ├── processes.test.ts
    └── mcp.integration.test.ts
```

Modify:

```text
.gitignore
.devcontainer/devcontainer.json
```

Generated/ignored at runtime:

```text
plugin/codespace/runtime/
├── bin/
├── profiles/
├── logs/
├── processes/
└── tunnel.json
```

---

### Task 1: Scaffold the isolated `codespace` package

**Files:**
- Create: `plugin/codespace/package.json`
- Create: `plugin/codespace/tsconfig.json`
- Create: `plugin/codespace/src/constants.ts`
- Create: `plugin/codespace/src/errors.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `BRIDGE_NAME`, `BRIDGE_VERSION`, `WORKSPACES_ROOT`, `RUNTIME_DIR`, `MAX_TEXT_BYTES`, `MAX_COMMAND_OUTPUT_BYTES`, `sanitizeEnvironment()`, and `CodespaceError` for later tasks.
- Consumes only root-installed Node/TypeScript/MCP dependencies; no second `npm install` tree is introduced.

- [ ] **Step 1: Write the failing smoke import test**

Create a temporary test in `plugin/codespace/tests/workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BRIDGE_NAME, BRIDGE_VERSION, sanitizeEnvironment } from '../src/constants.js';

describe('codespace constants', () => {
  it('uses the required identity and strips tunnel credentials', () => {
    expect(BRIDGE_NAME).toBe('codespace');
    expect(BRIDGE_VERSION).toBe('0.1.0');
    const env = sanitizeEnvironment({
      KEEP_ME: 'yes',
      CONTROL_PLANE_API_KEY: 'secret',
      OPENAI_ADMIN_KEY: 'admin',
    });
    expect(env.KEEP_ME).toBe('yes');
    expect(env.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(env.OPENAI_ADMIN_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run from repository root:

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
```

Expected: FAIL because `plugin/codespace/src/constants.ts` does not exist.

- [ ] **Step 3: Add package and compiler contracts**

`plugin/codespace/package.json`:

```json
{
  "name": "codespace",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "npx --no-install tsc -p tsconfig.json",
    "test": "npx --no-install vitest run tests",
    "verify": "npm run build && npm test"
  }
}
```

`plugin/codespace/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 4: Implement constants and structured errors**

`plugin/codespace/src/constants.ts` must include:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_NAME = 'codespace';
export const BRIDGE_VERSION = '0.1.0';
export const WORKSPACES_ROOT = '/workspaces';
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;

const here = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(here, '..');
export const RUNTIME_DIR = path.join(PACKAGE_ROOT, 'runtime');

const STRIPPED_ENV = new Set([
  'CONTROL_PLANE_API_KEY',
  'OPENAI_ADMIN_KEY',
]);

export function sanitizeEnvironment(
  input: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => !STRIPPED_ENV.has(name)),
  );
}
```

`plugin/codespace/src/errors.ts`:

```ts
export class CodespaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CodespaceError';
  }
}

export function errorPayload(error: unknown) {
  if (error instanceof CodespaceError) {
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  return { error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) } };
}
```

- [ ] **Step 5: Ignore only generated bridge runtime state**

Append to root `.gitignore`:

```gitignore
/plugin/codespace/runtime/
/plugin/codespace/dist/
```

Do not add a blanket `/plugin/codespace/` ignore.

- [ ] **Step 6: Run test and build GREEN**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
npx tsc -p plugin/codespace/tsconfig.json
```

Expected: PASS and zero TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add plugin/codespace/package.json plugin/codespace/tsconfig.json \
  plugin/codespace/src/constants.ts plugin/codespace/src/errors.ts \
  plugin/codespace/tests/workspace.test.ts .gitignore
git commit -m "feat(codespace): scaffold isolated bridge"
```

---

### Task 2: Resolve and enforce the `/workspaces` boundary

**Files:**
- Create: `plugin/codespace/src/workspace.ts`
- Modify: `plugin/codespace/tests/workspace.test.ts`

**Interfaces:**
- Produces `resolveWorkspaceRoot(options?)`, `resolveExistingPath(root, requested)`, and `resolveTargetPath(root, requested)`.
- Later filesystem, command, and process tools must use these functions rather than raw `path.resolve`.

- [ ] **Step 1: Add failing boundary tests**

Add tests that create a temporary workspace tree under a test override root and verify containment:

```ts
it('rejects traversal and symlink escape', async () => {
  const root = await makeWorkspaceFixture();
  await expect(resolveExistingPath(root, '../outside.txt')).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_WORKSPACE',
  });
  await expect(resolveExistingPath(root, 'escape-link/secret.txt')).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_WORKSPACE',
  });
});
```

Add root-resolution tests for explicit override, package repository root under `/workspaces`, single candidate, and ambiguous candidates.

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
```

Expected: FAIL on missing workspace functions.

- [ ] **Step 3: Implement canonical path resolution**

`workspace.ts` must:

1. Canonicalize the root with `fs.realpath`.
2. Require the canonical root to live under `/workspaces` in production; allow an explicit test-only base via function argument rather than an environment backdoor.
3. For existing paths, canonicalize with `realpath` before containment testing.
4. For target paths that do not yet exist, canonicalize the nearest existing parent, then append the unresolved tail.
5. Check containment with `path.relative(root, candidate)` and reject if the result starts with `..` or is absolute.
6. Return `CodespaceError('PATH_OUTSIDE_WORKSPACE', ...)` instead of leaking host paths in verbose stack traces.

Core containment helper:

```ts
function assertInside(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new CodespaceError('PATH_OUTSIDE_WORKSPACE', 'Requested path escapes the active workspace.');
}
```

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
```

Expected: PASS including symlink escape tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/codespace/src/workspace.ts plugin/codespace/tests/workspace.test.ts
git commit -m "feat(codespace): enforce workspace boundary"
```

---

### Task 3: Add bounded filesystem operations

**Files:**
- Create: `plugin/codespace/src/filesystem.ts`
- Create: `plugin/codespace/tests/filesystem.test.ts`

**Interfaces:**
- Produces `listDirectory`, `readTextFile`, `readMultipleFiles`, `searchFiles`, `writeTextFile`, `editTextFile`.
- Every function receives a resolved workspace root and delegates path validation to Task 2 helpers.

- [ ] **Step 1: Write failing tests**

Cover:

```ts
it('reads line ranges without crossing the byte cap', async () => { /* fixture + assertions */ });
it('rejects an edit when match count differs', async () => { /* expectedReplacements = 1, actual 2 */ });
it('search stops at maxResults', async () => { /* create > maxResults matches */ });
it('write cannot follow a symlink outside the root', async () => { /* expect PATH_OUTSIDE_WORKSPACE */ });
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/filesystem.test.ts
```

- [ ] **Step 3: Implement bounded UTF-8 file operations**

Implementation requirements:

- `readTextFile` checks size before loading and rejects files above `MAX_TEXT_BYTES` with `FILE_TOO_LARGE`.
- UTF-8 decode uses `TextDecoder('utf-8', { fatal: true })`; invalid text returns `UNSUPPORTED_TEXT_ENCODING`.
- `readMultipleFiles` accepts at most 50 paths.
- `listDirectory` and `searchFiles` cap results before returning them.
- Recursive search uses `lstat`/`realpath` and never descends through a symlink that resolves outside the workspace.
- `writeTextFile` creates parents only after `resolveTargetPath` proves containment.
- `editTextFile` counts exact string matches before replacement and throws `EDIT_MATCH_COUNT_MISMATCH` unless count equals `expectedReplacements`.

Exact edit core:

```ts
const count = current.split(oldString).length - 1;
if (count !== expectedReplacements) {
  throw new CodespaceError(
    'EDIT_MATCH_COUNT_MISMATCH',
    `Expected ${expectedReplacements} exact matches but found ${count}.`,
    { expectedReplacements, actualMatches: count },
  );
}
await fs.writeFile(file, current.split(oldString).join(newString), 'utf8');
```

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/filesystem.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugin/codespace/src/filesystem.ts plugin/codespace/tests/filesystem.test.ts
git commit -m "feat(codespace): add bounded filesystem tools"
```

---

### Task 4: Add foreground command execution with credential stripping

**Files:**
- Create: `plugin/codespace/src/commands.ts`
- Create: `plugin/codespace/tests/commands.test.ts`

**Interfaces:**
- Produces `executeCommand(root, input)` and `boundedCapture()`.
- Input contract: `{ command: string; cwd?: string; timeoutMs?: number; maxOutputBytes?: number }`.
- Output contract: `{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean; outputTruncated: boolean }`.

- [ ] **Step 1: Write failing tests**

Tests must prove:

```ts
it('runs in the validated workspace cwd', async () => { /* pwd equals fixture cwd */ });
it('does not inherit CONTROL_PLANE_API_KEY', async () => {
  const result = await executeCommand(root, { command: 'printf %s "${CONTROL_PLANE_API_KEY-unset}"' });
  expect(result.stdout).toBe('unset');
});
it('times out and terminates the process group', async () => { /* sleep beyond timeout */ });
it('caps combined output and reports truncation', async () => { /* generate > max bytes */ });
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/commands.test.ts
```

- [ ] **Step 3: Implement shell execution**

Use Linux Codespaces contract:

```ts
const child = spawn('/bin/bash', ['-lc', input.command], {
  cwd,
  env: sanitizeEnvironment(),
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

On timeout, send `SIGTERM` to process group with `process.kill(-child.pid!, 'SIGTERM')`, wait a short grace period, then `SIGKILL` if still alive. The test abstraction must allow Windows/local tests to skip process-group assertions while Codespaces integration requires them.

Output capture must stop storing bytes after the cap but continue draining streams so the child cannot block on a full pipe.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/commands.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugin/codespace/src/commands.ts plugin/codespace/tests/commands.test.ts
git commit -m "feat(codespace): add bounded command execution"
```

---

### Task 5: Add owned background process sessions

**Files:**
- Create: `plugin/codespace/src/processes.ts`
- Create: `plugin/codespace/tests/processes.test.ts`

**Interfaces:**
- Produces `ProcessManager` with `start`, `read`, `stop`, `list`, and `reconcile`.
- Session IDs are UUIDs; callers never provide PIDs.

- [ ] **Step 1: Write failing tests**

Test:

```ts
it('returns only owned opaque sessions', async () => { /* start two + list */ });
it('reads bounded stdout and stderr snapshots', async () => { /* child prints both */ });
it('stop is idempotent for terminal sessions', async () => { /* stop twice */ });
it('rejects unknown session ids', () => { /* UNKNOWN_PROCESS_SESSION */ });
it('reconciles stale metadata without treating the PID as alive', async () => { /* fake metadata */ });
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/processes.test.ts
```

- [ ] **Step 3: Implement process state**

Persist each session as:

```json
{
  "sessionId": "uuid",
  "pid": 1234,
  "cwd": "/workspaces/repo",
  "command": "npm run dev",
  "startedAt": 0,
  "terminalAt": null,
  "exitCode": null,
  "signal": null,
  "stdoutPath": "...",
  "stderrPath": "..."
}
```

Requirements:

- Metadata and logs live below `runtime/processes/`.
- `start` validates cwd and strips tunnel credentials.
- `read` caps returned log bytes.
- `stop` targets only the recorded process group for a known session.
- `reconcile` uses `process.kill(pid, 0)` only as a liveness hint and marks missing PIDs terminal; it never adopts unrelated processes.
- Commands themselves are recorded because this is an operator-owned private development bridge, but secret environment values are not.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/processes.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugin/codespace/src/processes.ts plugin/codespace/tests/processes.test.ts
git commit -m "feat(codespace): add owned background processes"
```

---

### Task 6: Register the MCP stdio server and full v0.1 tool surface

**Files:**
- Create: `plugin/codespace/src/server.ts`
- Create: `plugin/codespace/tests/mcp.integration.test.ts`
- Create: `plugin/codespace/scripts/start-mcp.sh`

**Interfaces:**
- Server identity: name `codespace`, version `0.1.0`.
- Tools: `codespace_status`, `list_directory`, `read_file`, `read_multiple_files`, `search_files`, `write_file`, `edit_file`, `execute_command`, `start_process`, `read_process_output`, `stop_process`, `list_processes`.

- [ ] **Step 1: Write failing MCP integration test**

Use the official SDK client over stdio:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'codespace-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['plugin/codespace/dist/server.js'],
  env: { ...process.env, CODESPACE_WORKSPACE_ROOT: fixtureRoot },
});
await client.connect(transport);
const listed = await client.listTools();
expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
  'codespace_status', 'read_file', 'execute_command', 'start_process',
]));
```

The integration test must also call one read, one write/edit in a temporary workspace override, and one harmless command.

- [ ] **Step 2: Build and run RED**

```bash
npx tsc -p plugin/codespace/tsconfig.json
npx vitest run plugin/codespace/tests/mcp.integration.test.ts
```

Expected: FAIL because server is not implemented.

- [ ] **Step 3: Implement MCP server**

Use:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
```

Tool handlers return concise JSON text plus `structuredContent` where the SDK accepts it. Read-only annotations must be accurate. Mutation/open-world hints must be accurate for command and file writes.

All handler errors pass through `errorPayload`; no stack traces or environment dumps are returned.

`codespace_status` may call `git branch --show-current` through the sanitized command runner, but must return only branch, workspace root, runtime platform, bridge version, and owned process counts.

- [ ] **Step 4: Create the sanitized stdio launcher**

`plugin/codespace/scripts/start-mcp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
unset CONTROL_PLANE_API_KEY
unset OPENAI_ADMIN_KEY
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/dist/server.js"
```

No stdout logging is allowed before `exec`; diagnostics go to stderr.

- [ ] **Step 5: Run MCP GREEN**

```bash
npx tsc -p plugin/codespace/tsconfig.json
npx vitest run plugin/codespace/tests/mcp.integration.test.ts
```

- [ ] **Step 6: Run all bridge tests GREEN**

```bash
npx vitest run plugin/codespace/tests
```

- [ ] **Step 7: Commit**

```bash
git add plugin/codespace/src/server.ts plugin/codespace/scripts/start-mcp.sh \
  plugin/codespace/tests/mcp.integration.test.ts
git commit -m "feat(codespace): expose stdio MCP workspace tools"
```

---

### Task 7: Install and configure pinned `tunnel-client v0.0.13`

**Files:**
- Create: `plugin/codespace/config/tunnel.defaults.json`
- Create: `plugin/codespace/scripts/install-tunnel-client.sh`
- Create: `plugin/codespace/scripts/configure-tunnel.sh`

**Interfaces:**
- Installer outputs executable path `plugin/codespace/runtime/bin/tunnel-client`.
- Tunnel config resolution: `CODESPACE_TUNNEL_ID` → `CONTROL_PLANE_TUNNEL_ID` → `runtime/tunnel.json`.
- `configure-tunnel.sh <tunnel-id>` writes ignored runtime config only; it never writes API keys.

- [ ] **Step 1: Add shell-level installer assertions to `verify.sh` skeleton**

Before the installer exists, the script should fail on:

```bash
[[ -x "$ROOT/runtime/bin/tunnel-client" ]]
"$ROOT/runtime/bin/tunnel-client" version
```

- [ ] **Step 2: Run RED in Codespaces**

```bash
bash plugin/codespace/scripts/verify.sh --installer-only
```

Expected: FAIL because the binary is missing.

- [ ] **Step 3: Implement exact release asset mapping**

For `uname -m`:

```text
x86_64 -> tunnel-client-v0.0.13-linux-amd64.zip
           sha256 e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906

aarch64|arm64 -> tunnel-client-v0.0.13-linux-arm64.zip
                 sha256 9d214a805bec213a3a156dc2a4460a6dfe2f35b0c00ba20609d002bf5e6469f8
```

Download from the official release URL only:

```text
https://github.com/openai/tunnel-client/releases/download/v0.0.13/<asset>
```

The installer must also download `SHA256SUMS.txt`, select the exact asset line, verify that the manifest hash equals the pinned expected hash, then verify the downloaded ZIP with `sha256sum -c`. Extract into a temporary runtime directory and atomically replace the bridge-owned binary.

Reject unsupported architectures with `TUNNEL_CLIENT_ARCH_UNSUPPORTED`.

- [ ] **Step 4: Add non-secret tunnel defaults**

`config/tunnel.defaults.json`:

```json
{
  "alias": "codespace",
  "profile": "codespace",
  "tunnelClientVersion": "v0.0.13"
}
```

`configure-tunnel.sh` accepts exactly a value matching `^tunnel_[A-Za-z0-9_-]+$` and writes:

```json
{"tunnelId":"<validated argument>"}
```

to `runtime/tunnel.json` with mode `0600`. Although tunnel ID is not the API credential, keeping user-specific runtime identity out of Git history preserves portability.

- [ ] **Step 5: Run installer GREEN in Codespaces**

```bash
bash plugin/codespace/scripts/install-tunnel-client.sh
plugin/codespace/runtime/bin/tunnel-client version
```

Expected: version output identifies `v0.0.13`.

- [ ] **Step 6: Commit**

```bash
git add plugin/codespace/config/tunnel.defaults.json \
  plugin/codespace/scripts/install-tunnel-client.sh \
  plugin/codespace/scripts/configure-tunnel.sh
git commit -m "feat(codespace): pin secure tunnel runtime"
```

---

### Task 8: Add idempotent managed-runtime startup and repair

**Files:**
- Create: `plugin/codespace/scripts/ensure-running.sh`
- Create/complete: `plugin/codespace/scripts/verify.sh`

**Interfaces:**
- `ensure-running.sh [--phase create|start|attach|manual]` is the single startup entry point.
- `verify.sh` is the single reproducible verification entry point.

- [ ] **Step 1: Write shell contract checks first**

`verify.sh --static` must assert:

```bash
grep -q -- '--mcp-command' "$ROOT/scripts/ensure-running.sh"
grep -q 'CONTROL_PLANE_API_KEY' "$ROOT/scripts/ensure-running.sh"
! grep -R --line-number 'Server URL\|app.github.dev\|cloudflare' "$ROOT/src" "$ROOT/scripts/start-mcp.sh"
```

The last check applies to the new bridge code only, not repository-wide historical files.

- [ ] **Step 2: Run static RED**

```bash
bash plugin/codespace/scripts/verify.sh --static
```

- [ ] **Step 3: Implement runtime configuration resolution**

`ensure-running.sh` must:

1. Fail with one clear message if `CONTROL_PLANE_API_KEY` is empty.
2. Resolve tunnel ID from `CODESPACE_TUNNEL_ID`, then `CONTROL_PLANE_TUNNEL_ID`, then `runtime/tunnel.json`.
3. If no tunnel ID exists, fail with a single command the operator can run:

```text
bash plugin/codespace/scripts/configure-tunnel.sh <tunnel-id>
```

4. Run installer.
5. Build bridge with `npx tsc -p plugin/codespace/tsconfig.json` when output is missing/stale.
6. Run the MCP integration test before touching tunnel runtime.
7. Use managed runtime, never `nohup`/`disown`.

- [ ] **Step 4: Implement connect/repair semantics**

Use the exact supported form:

```bash
"$TUNNEL_BIN" runtimes connect \
  --alias codespace \
  --tunnel-id "$TUNNEL_ID" \
  --profile codespace \
  --profile-dir "$ROOT/runtime/profiles" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "bash $ROOT/scripts/start-mcp.sh"
```

Then always inspect:

```bash
"$TUNNEL_BIN" runtimes status codespace --json
```

Parse JSON with Node, not grep. Require explicit truthy `process_running`, `healthy`, and `ready` fields when present in the v0.0.13 status payload. If the actual field nesting differs, adapt the parser to v0.0.13's observed JSON and lock that shape in a fixture test before continuing.

If an existing alias points at a stale profile/MCP command, stop/remove only the local alias metadata and reconnect the same remote tunnel ID. Never delete the remote tunnel.

- [ ] **Step 5: Add `doctor` and readiness evidence**

Before `runtimes connect`, run:

```bash
"$TUNNEL_BIN" doctor --profile codespace --profile-dir "$ROOT/runtime/profiles" --explain
```

If v0.0.13 does not accept `--profile-dir` on `doctor`, use the generated profile path/environment documented by `tunnel-client help doctor`; record the exact supported invocation in the script and test it in Codespaces.

Capture operator diagnostics under `runtime/logs/` with secret values redacted by construction, not post-hoc regex over a full environment dump.

- [ ] **Step 6: Emit READY only after gates pass**

Final stdout line:

```text
[codespace] READY: MCP integration, managed tunnel process, health, and readiness gates passed.
```

Do not include API key, admin key, or public endpoint values.

- [ ] **Step 7: Run GREEN in Codespaces**

```bash
bash plugin/codespace/scripts/ensure-running.sh --phase manual
bash plugin/codespace/scripts/verify.sh
```

Expected: both zero exit; status reports running + healthy + ready.

- [ ] **Step 8: Commit**

```bash
git add plugin/codespace/scripts/ensure-running.sh plugin/codespace/scripts/verify.sh
git commit -m "feat(codespace): add managed tunnel lifecycle"
```

---

### Task 9: Compose dev-container lifecycle without coupling the old lifecycle to the new bridge

**Files:**
- Modify: `.devcontainer/devcontainer.json`

**Interfaces:**
- Dev Container object-form lifecycle commands run named entries in parallel. Each new `codespace` entry calls only `plugin/codespace/scripts/ensure-running.sh`.

- [ ] **Step 1: Write the desired lifecycle shape as a failing static assertion**

Add to `verify.sh --static` a Node assertion that `.devcontainer/devcontainer.json` has object values and both keys per phase:

```js
for (const phase of ['postCreateCommand', 'postStartCommand', 'postAttachCommand']) {
  if (typeof config[phase] !== 'object' || Array.isArray(config[phase])) process.exit(1);
  if (!config[phase].existing || !config[phase].codespace) process.exit(1);
}
```

- [ ] **Step 2: Run RED**

```bash
bash plugin/codespace/scripts/verify.sh --static
```

Expected: FAIL because the current lifecycle values are strings.

- [ ] **Step 3: Convert lifecycle strings to independent object entries**

Preserve the existing commands exactly and add the new bridge independently:

```json
{
  "postCreateCommand": {
    "existing": "bash scripts/codespace/bootstrap.sh --phase create",
    "codespace": "bash plugin/codespace/scripts/ensure-running.sh --phase create"
  },
  "postStartCommand": {
    "existing": "bash scripts/codespace/bootstrap.sh --phase start",
    "codespace": "bash plugin/codespace/scripts/ensure-running.sh --phase start"
  },
  "postAttachCommand": {
    "existing": "bash scripts/codespace/ensure-running.sh --repair --phase attach",
    "codespace": "bash plugin/codespace/scripts/ensure-running.sh --phase attach"
  }
}
```

Keep current image/port settings unchanged in this task. The new bridge does not depend on the forwarded port even though the repository still has unrelated port configuration.

- [ ] **Step 4: Run static GREEN**

```bash
bash plugin/codespace/scripts/verify.sh --static
```

- [ ] **Step 5: Commit**

```bash
git add .devcontainer/devcontainer.json plugin/codespace/scripts/verify.sh
git commit -m "feat(codespace): auto-start bridge in codespaces"
```

---

### Task 10: Full verification and ChatGPT acceptance

**Files:**
- Modify as needed only to fix evidence-backed failures from Tasks 1-9.

**Interfaces:**
- Final evidence must prove code, MCP, managed tunnel runtime, and ChatGPT tool invocation.

- [ ] **Step 1: Run the complete bridge suite**

```bash
npx tsc -p plugin/codespace/tsconfig.json
npx vitest run plugin/codespace/tests
bash plugin/codespace/scripts/verify.sh --static
```

Expected: all PASS.

- [ ] **Step 2: Configure tunnel ID once if runtime config is absent**

Use the tunnel ID visible in the user's OpenAI Platform Tunnels page, but do not commit it:

```bash
bash plugin/codespace/scripts/configure-tunnel.sh "$CODESPACE_TUNNEL_ID"
```

If `CODESPACE_TUNNEL_ID` is not already exported, the operator pastes only the non-secret tunnel ID into this one-time command. Never paste `CONTROL_PLANE_API_KEY` into chat or the repository.

- [ ] **Step 3: Run managed runtime verification**

```bash
bash plugin/codespace/scripts/ensure-running.sh --phase manual
plugin/codespace/runtime/bin/tunnel-client runtimes status codespace --json
```

Expected: process running, healthy, ready.

- [ ] **Step 4: Prove restart repair**

```bash
plugin/codespace/runtime/bin/tunnel-client runtimes stop codespace
bash plugin/codespace/scripts/ensure-running.sh --phase manual
plugin/codespace/runtime/bin/tunnel-client runtimes status codespace --json
```

Expected: repair returns runtime to running + healthy + ready without creating a new remote tunnel or changing a public URL.

- [ ] **Step 5: Create/refresh the ChatGPT custom plugin**

In ChatGPT:

```text
Name: codespace
Connection: Tunnel
Tunnel: Codespace
```

No Server URL is entered.

- [ ] **Step 6: Run final ChatGPT smoke tests**

Invoke through the new plugin:

```text
codespace_status
read_file(package.json)
execute_command("pwd")
execute_command("git status --short")
```

Acceptance requires the reported workspace path to be the active `/workspaces/...` repository and the command outputs to come from that repository.

- [ ] **Step 7: Verify credential non-exposure through the plugin**

Run:

```text
execute_command("printf %s \"${CONTROL_PLANE_API_KEY-unset}\"")
```

Expected output: `unset`.

- [ ] **Step 8: Run repository regression checks**

```bash
npm run build
npm test
```

Expected: existing repository suite remains green.

- [ ] **Step 9: Final commit for evidence-backed fixes only**

```bash
git status --short
git add <only files changed to fix verified failures>
git commit -m "fix(codespace): close acceptance gaps"
```

Skip this commit if the tree is already clean.

- [ ] **Step 10: Completion rule**

Only report `codespace v0.1 READY` after:

```text
TypeScript build PASS
bridge unit tests PASS
MCP stdio integration PASS
workspace boundary PASS
tunnel-client checksum/version PASS
managed runtime process_running PASS
managed runtime healthy PASS
managed runtime ready PASS
restart repair PASS
ChatGPT tool discovery PASS
ChatGPT read smoke PASS
ChatGPT command smoke PASS
credential non-exposure PASS
repository regression PASS
```
