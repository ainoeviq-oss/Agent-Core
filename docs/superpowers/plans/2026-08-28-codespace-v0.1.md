# Codespace v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a private ChatGPT plugin named `codespace` that reaches the active GitHub Codespace through OpenAI Tunnel, launches a small MCP server over stdio, and gives ChatGPT bounded workspace filesystem, shell, and background-process control without a public Codespaces port or custom OAuth.

**Architecture:** `tunnel-client v0.0.13` is the only network-facing runtime. It maintains the outbound OpenAI Tunnel connection and starts `plugin/codespace` through `--mcp-command`. The MCP child resolves one `/workspaces/...` repository, constrains every file and cwd operation to that root, strips tunnel credentials from itself and its children, and exposes a compact tool set. Dev-container lifecycle hooks use object form so existing repository lifecycle commands and the new `codespace` lifecycle run independently.

**Tech Stack:** Node.js 24+, TypeScript 7.0.2, `@modelcontextprotocol/sdk` 1.30.0, Zod 4.4.3, Vitest 4.1.11, Bash, OpenAI `tunnel-client` v0.0.13, GitHub Codespaces Dev Container lifecycle.

**Spec:** `docs/superpowers/specs/2026-08-28-codespace-v0.1-design.md`

## Global Constraints

- Plugin identity is exactly `codespace`.
- New bridge implementation lives under `plugin/codespace/`; only `.devcontainer/devcontainer.json` and `.gitignore` are modified outside that directory.
- No source, auth store, gateway configuration, runtime state, or startup contract from the previous plugin implementation is imported.
- ChatGPT uses **Connection: Tunnel**, never **Server URL**, for this bridge.
- No custom OAuth, Cloudflare gateway, SSE endpoint, or public Codespaces port is required by the bridge.
- MCP transport from `tunnel-client` to the bridge is stdio.
- `CONTROL_PLANE_API_KEY` is consumed only by `tunnel-client`; the MCP process and every tool-spawned child have it removed from their environment.
- Filesystem and command access stay within one canonical workspace root under `/workspaces`.
- `READY` is printed only after MCP self-test plus managed-runtime running, health, and readiness gates pass.
- `tunnel-client` is pinned to `v0.0.13`; the official release ZIP is SHA-256 verified before installation.
- Tunnel identity is runtime configuration: `CODESPACE_TUNNEL_ID`, then `CONTROL_PLANE_TUNNEL_ID`, then ignored `runtime/tunnel.json`. The bridge never creates or deletes remote tunnels.
- Existing dev-container lifecycle commands remain present and are not made dependencies of the new bridge lifecycle.

---

## File Map

Create:

```text
plugin/codespace/package.json
plugin/codespace/tsconfig.json
plugin/codespace/src/constants.ts
plugin/codespace/src/errors.ts
plugin/codespace/src/workspace.ts
plugin/codespace/src/filesystem.ts
plugin/codespace/src/commands.ts
plugin/codespace/src/processes.ts
plugin/codespace/src/server.ts
plugin/codespace/scripts/install-tunnel-client.sh
plugin/codespace/scripts/configure-tunnel.sh
plugin/codespace/scripts/start-mcp.sh
plugin/codespace/scripts/ensure-running.sh
plugin/codespace/scripts/verify.sh
plugin/codespace/config/tunnel.defaults.json
plugin/codespace/tests/workspace.test.ts
plugin/codespace/tests/filesystem.test.ts
plugin/codespace/tests/commands.test.ts
plugin/codespace/tests/processes.test.ts
plugin/codespace/tests/mcp.integration.test.ts
```

Modify:

```text
.gitignore
.devcontainer/devcontainer.json
```

Generated and ignored:

```text
plugin/codespace/runtime/bin/
plugin/codespace/runtime/profiles/
plugin/codespace/runtime/logs/
plugin/codespace/runtime/processes/
plugin/codespace/runtime/tunnel.json
```

---

### Task 1: Scaffold the isolated bridge contract

**Files:**
- Create: `plugin/codespace/package.json`
- Create: `plugin/codespace/tsconfig.json`
- Create: `plugin/codespace/src/constants.ts`
- Create: `plugin/codespace/src/errors.ts`
- Create: `plugin/codespace/tests/workspace.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces `BRIDGE_NAME`, `BRIDGE_VERSION`, `WORKSPACES_ROOT`, `PACKAGE_ROOT`, `RUNTIME_DIR`, `MAX_TEXT_BYTES`, `MAX_COMMAND_OUTPUT_BYTES`, `sanitizeEnvironment`, `CodespaceError`, and `errorPayload`.

- [ ] **Step 1: Write the failing identity and secret-stripping test**

```ts
import { describe, expect, it } from 'vitest';
import { BRIDGE_NAME, BRIDGE_VERSION, sanitizeEnvironment } from '../src/constants.js';

describe('bridge contract', () => {
  it('uses the required identity and strips tunnel credentials', () => {
    expect(BRIDGE_NAME).toBe('codespace');
    expect(BRIDGE_VERSION).toBe('0.1.0');
    const env = sanitizeEnvironment({
      KEEP_ME: 'yes',
      CONTROL_PLANE_API_KEY: 'secret-value',
      OPENAI_ADMIN_KEY: 'admin-value',
    });
    expect(env.KEEP_ME).toBe('yes');
    expect(env.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(env.OPENAI_ADMIN_KEY).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
```

Expected: import failure because `constants.ts` does not exist.

- [ ] **Step 3: Create package metadata and compiler config**

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

The package intentionally reuses the repository root `node_modules`; no second dependency tree is installed.

- [ ] **Step 4: Implement constants and errors**

`constants.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BRIDGE_NAME = 'codespace';
export const BRIDGE_VERSION = '0.1.0';
export const WORKSPACES_ROOT = '/workspaces';
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(sourceDir, '..');
export const RUNTIME_DIR = path.join(PACKAGE_ROOT, 'runtime');

const STRIPPED_ENV = new Set(['CONTROL_PLANE_API_KEY', 'OPENAI_ADMIN_KEY']);
export function sanitizeEnvironment(input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(input).filter(([name]) => !STRIPPED_ENV.has(name)));
}
```

`errors.ts`:

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
  return {
    error: {
      code: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
```

- [ ] **Step 5: Ignore generated runtime/build output**

Append exactly:

```gitignore
/plugin/codespace/runtime/
/plugin/codespace/dist/
```

- [ ] **Step 6: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
npx tsc -p plugin/codespace/tsconfig.json
```

- [ ] **Step 7: Commit**

```bash
git add plugin/codespace .gitignore
git commit -m "feat(codespace): scaffold isolated bridge"
```

---

### Task 2: Enforce canonical workspace containment

**Files:**
- Create: `plugin/codespace/src/workspace.ts`
- Modify: `plugin/codespace/tests/workspace.test.ts`

**Interfaces:**
- Produces `assertInside`, `resolveWorkspaceRoot`, `resolveExistingPath`, and `resolveTargetPath`.
- Every later file/cwd operation consumes these helpers.

- [ ] **Step 1: Add concrete failing tests**

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveExistingPath, resolveTargetPath } from '../src/workspace.js';

it('accepts a file inside the workspace', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'inside.txt'), 'ok');
  await expect(resolveExistingPath(root, 'inside.txt', base)).resolves.toBe(path.join(root, 'inside.txt'));
});

it('rejects parent traversal', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(base, 'outside.txt'), 'no');
  await expect(resolveExistingPath(root, '../outside.txt', base)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
});

it('rejects a symlink escape', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
  const root = path.join(base, 'repo');
  const outside = path.join(base, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'no');
  await fs.symlink(outside, path.join(root, 'escape'));
  await expect(resolveExistingPath(root, 'escape/secret.txt', base)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
});

it('allows a new target only when its nearest existing parent is inside', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'codespace-root-'));
  const root = path.join(base, 'repo');
  await fs.mkdir(root);
  await expect(resolveTargetPath(root, 'nested/new.txt', base)).resolves.toBe(path.join(root, 'nested/new.txt'));
});
```

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
```

- [ ] **Step 3: Implement containment**

`workspace.ts` must use `realpath` for existing paths, validate the nearest existing ancestor for new targets, and use this helper:

```ts
export function assertInside(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return candidate;
  throw new CodespaceError('PATH_OUTSIDE_WORKSPACE', 'Requested path escapes the active workspace.');
}
```

`resolveWorkspaceRoot` uses this order: explicit `CODESPACE_WORKSPACE_ROOT`, package repository root when it is below `/workspaces`, then one Git repository candidate below `/workspaces`; ambiguity fails with `WORKSPACE_AMBIGUOUS`.

The optional third `allowedBase` argument exists only for tests. Production calls omit it, forcing `/workspaces`.

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/workspace.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugin/codespace/src/workspace.ts plugin/codespace/tests/workspace.test.ts
git commit -m "feat(codespace): enforce workspace boundary"
```

---

### Task 3: Implement bounded filesystem operations

**Files:**
- Create: `plugin/codespace/src/filesystem.ts`
- Create: `plugin/codespace/tests/filesystem.test.ts`

**Interfaces:**
- Produces `listDirectory`, `readTextFile`, `readMultipleFiles`, `searchFiles`, `writeTextFile`, `editTextFile`.

- [ ] **Step 1: Write concrete failing tests**

```ts
it('rejects ambiguous exact edits', async () => {
  await fs.writeFile(path.join(root, 'a.txt'), 'same same');
  await expect(editTextFile(root, {
    path: 'a.txt', oldString: 'same', newString: 'new', expectedReplacements: 1,
  }, base)).rejects.toMatchObject({ code: 'EDIT_MATCH_COUNT_MISMATCH' });
});

it('caps search results', async () => {
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(path.join(root, `match-${index}.txt`), 'needle');
  }
  const result = await searchFiles(root, { query: 'needle', mode: 'content', maxResults: 2 }, base);
  expect(result.matches).toHaveLength(2);
  expect(result.truncated).toBe(true);
});

it('writes and reads utf8 inside the workspace', async () => {
  await writeTextFile(root, { path: 'nested/value.txt', content: 'hello', mode: 'rewrite' }, base);
  const value = await readTextFile(root, { path: 'nested/value.txt' }, base);
  expect(value.text).toBe('hello');
});
```

The test file creates `base` and `root` in `beforeEach` using `fs.mkdtemp` and removes `base` in `afterEach`.

- [ ] **Step 2: Run RED**

```bash
npx vitest run plugin/codespace/tests/filesystem.test.ts
```

- [ ] **Step 3: Implement bounded text operations**

Requirements:

```ts
const decoder = new TextDecoder('utf-8', { fatal: true });
```

- Reject files larger than `MAX_TEXT_BYTES` before reading.
- `readMultipleFiles` accepts 1-50 paths.
- Recursive directory and search operations stop at caller result limits.
- Symlinks are resolved and checked against the canonical workspace before descent.
- `writeTextFile` validates the target before creating parents.
- Exact edits count matches before replacement:

```ts
const actualMatches = current.split(input.oldString).length - 1;
if (actualMatches !== input.expectedReplacements) {
  throw new CodespaceError(
    'EDIT_MATCH_COUNT_MISMATCH',
    `Expected ${input.expectedReplacements} exact matches but found ${actualMatches}.`,
    { expectedReplacements: input.expectedReplacements, actualMatches },
  );
}
```

- [ ] **Step 4: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/filesystem.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add plugin/codespace/src/filesystem.ts plugin/codespace/tests/filesystem.test.ts
git commit -m "feat(codespace): add bounded filesystem operations"
```

---

### Task 4: Implement sanitized foreground commands and owned process sessions

**Files:**
- Create: `plugin/codespace/src/commands.ts`
- Create: `plugin/codespace/src/processes.ts`
- Create: `plugin/codespace/tests/commands.test.ts`
- Create: `plugin/codespace/tests/processes.test.ts`

**Interfaces:**
- `executeCommand(root, input, allowedBase?)` returns `{ exitCode, stdout, stderr, timedOut, outputTruncated }`.
- `ProcessManager` produces opaque UUID session IDs and supports `start`, `read`, `stop`, `list`, `reconcile`.

- [ ] **Step 1: Write failing command tests**

```ts
it('strips the tunnel runtime key', async () => {
  process.env.CONTROL_PLANE_API_KEY = 'do-not-leak';
  const result = await executeCommand(root, {
    command: 'printf %s "${CONTROL_PLANE_API_KEY-unset}"',
    timeoutMs: 5000,
  }, base);
  expect(result.stdout).toBe('unset');
});

it('enforces cwd containment', async () => {
  await expect(executeCommand(root, { command: 'pwd', cwd: '..' }, base)).rejects.toMatchObject({
    code: 'PATH_OUTSIDE_WORKSPACE',
  });
});

it('reports timeout', async () => {
  const result = await executeCommand(root, { command: 'sleep 2', timeoutMs: 50 }, base);
  expect(result.timedOut).toBe(true);
});
```

- [ ] **Step 2: Write failing process tests**

```ts
it('lists only manager-owned sessions and stop is idempotent', async () => {
  const manager = new ProcessManager(root, runtimeDir, base);
  const started = await manager.start({ command: 'sleep 30' });
  expect(manager.list().map((item) => item.sessionId)).toContain(started.sessionId);
  await manager.stop(started.sessionId);
  await expect(manager.stop(started.sessionId)).resolves.toMatchObject({ sessionId: started.sessionId });
});

it('rejects unknown session ids', async () => {
  const manager = new ProcessManager(root, runtimeDir, base);
  await expect(manager.stop('missing-session')).rejects.toMatchObject({ code: 'UNKNOWN_PROCESS_SESSION' });
});
```

- [ ] **Step 3: Run RED**

```bash
npx vitest run plugin/codespace/tests/commands.test.ts plugin/codespace/tests/processes.test.ts
```

- [ ] **Step 4: Implement command execution**

Use:

```ts
const child = spawn('/bin/bash', ['-lc', input.command], {
  cwd,
  env: sanitizeEnvironment(),
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Continue draining stdout/stderr after the storage cap so the child cannot deadlock. On timeout, terminate the process group on Linux; Windows-only local tests may terminate the child PID directly. Linux Codespaces acceptance must exercise the process-group path.

- [ ] **Step 5: Implement process sessions**

Each persisted JSON record contains exactly:

```json
{
  "sessionId": "uuid-string",
  "pid": 1234,
  "command": "npm run dev",
  "cwd": "/workspaces/repository",
  "startedAt": 1780000000000,
  "terminalAt": null,
  "exitCode": null,
  "signal": null,
  "stdoutPath": "runtime/processes/uuid-string.stdout.log",
  "stderrPath": "runtime/processes/uuid-string.stderr.log"
}
```

Process APIs accept session ID only; arbitrary PIDs are never accepted. `reconcile` marks missing PIDs terminal and never adopts a process that does not have bridge-owned metadata.

- [ ] **Step 6: Run GREEN**

```bash
npx vitest run plugin/codespace/tests/commands.test.ts plugin/codespace/tests/processes.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add plugin/codespace/src/commands.ts plugin/codespace/src/processes.ts \
  plugin/codespace/tests/commands.test.ts plugin/codespace/tests/processes.test.ts
git commit -m "feat(codespace): add shell and process control"
```

---

### Task 5: Register the MCP stdio server

**Files:**
- Create: `plugin/codespace/src/server.ts`
- Create: `plugin/codespace/tests/mcp.integration.test.ts`
- Create: `plugin/codespace/scripts/start-mcp.sh`

**Interfaces:**
- Server: name `codespace`, version `0.1.0`, stdio transport.
- Tools: `codespace_status`, `list_directory`, `read_file`, `read_multiple_files`, `search_files`, `write_file`, `edit_file`, `execute_command`, `start_process`, `read_process_output`, `stop_process`, `list_processes`.

- [ ] **Step 1: Write failing MCP integration test**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

it('initializes, lists tools, reads, edits, and runs a harmless command', async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['plugin/codespace/dist/server.js'],
    env: { ...process.env, CODESPACE_WORKSPACE_ROOT: root, CODESPACE_TEST_ALLOWED_BASE: base },
  });
  const client = new Client({ name: 'codespace-test', version: '1.0.0' });
  await client.connect(transport);
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
    'codespace_status', 'read_file', 'write_file', 'edit_file', 'execute_command', 'start_process',
  ]));
  const pwd = await client.callTool({ name: 'execute_command', arguments: { command: 'pwd' } });
  expect(JSON.stringify(pwd)).toContain(root);
  await client.close();
});
```

`CODESPACE_TEST_ALLOWED_BASE` is accepted by `server.ts` only when `NODE_ENV === 'test'`; production ignores it.

- [ ] **Step 2: Build and run RED**

```bash
npx tsc -p plugin/codespace/tsconfig.json
NODE_ENV=test npx vitest run plugin/codespace/tests/mcp.integration.test.ts
```

- [ ] **Step 3: Implement server registration**

Use:

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
```

All tool descriptions begin with a clear use condition. Read-only and destructive/open-world annotations reflect the real side effects. Errors return small structured payloads; stack traces and environment dumps are never returned.

`codespace_status` returns only bridge version, canonical workspace root, runtime platform, Git branch when available, and process-session counts.

- [ ] **Step 4: Create the sanitized launcher**

`start-mcp.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
unset CONTROL_PLANE_API_KEY
unset OPENAI_ADMIN_KEY
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/dist/server.js"
```

No text is printed to stdout before `exec`.

- [ ] **Step 5: Run GREEN**

```bash
npx tsc -p plugin/codespace/tsconfig.json
NODE_ENV=test npx vitest run plugin/codespace/tests/mcp.integration.test.ts
npx vitest run plugin/codespace/tests
```

- [ ] **Step 6: Commit**

```bash
git add plugin/codespace/src/server.ts plugin/codespace/scripts/start-mcp.sh \
  plugin/codespace/tests/mcp.integration.test.ts
git commit -m "feat(codespace): expose stdio MCP tools"
```

---

### Task 6: Pin and install `tunnel-client v0.0.13`

**Files:**
- Create: `plugin/codespace/config/tunnel.defaults.json`
- Create: `plugin/codespace/scripts/install-tunnel-client.sh`
- Create: `plugin/codespace/scripts/configure-tunnel.sh`
- Create: `plugin/codespace/scripts/verify.sh`

**Interfaces:**
- Installer produces `runtime/bin/tunnel-client`.
- Tunnel ID resolution is `CODESPACE_TUNNEL_ID`, then `CONTROL_PLANE_TUNNEL_ID`, then `runtime/tunnel.json`.

- [ ] **Step 1: Create a failing installer-only verification**

`verify.sh` initially contains:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--installer-only" ]]; then
  [[ -x "$ROOT/runtime/bin/tunnel-client" ]]
  "$ROOT/runtime/bin/tunnel-client" version
  exit 0
fi
```

- [ ] **Step 2: Run RED in Codespaces**

```bash
bash plugin/codespace/scripts/verify.sh --installer-only
```

Expected: non-zero because the binary is absent.

- [ ] **Step 3: Implement exact Linux release mapping**

Use these official v0.0.13 assets and pinned SHA-256 values:

```text
x86_64  -> tunnel-client-v0.0.13-linux-amd64.zip
sha256  -> e71f37b424126513173d5e3590687c0b5ccf6e8ef3fba900104d1f8c60dad906

aarch64 -> tunnel-client-v0.0.13-linux-arm64.zip
arm64    -> tunnel-client-v0.0.13-linux-arm64.zip
sha256  -> 9d214a805bec213a3a156dc2a4460a6dfe2f35b0c00ba20609d002bf5e6469f8
```

Download the ZIP and `SHA256SUMS.txt` only from `https://github.com/openai/tunnel-client/releases/download/v0.0.13/`. Select the exact manifest line for the asset, require the manifest hash to equal the pinned hash above, then verify the ZIP with `sha256sum -c`. Extract to a temporary directory, locate the `tunnel-client` executable, and atomically install it to `runtime/bin/tunnel-client`.

- [ ] **Step 4: Create runtime tunnel configuration**

`tunnel.defaults.json`:

```json
{
  "alias": "codespace",
  "profile": "codespace",
  "tunnelClientVersion": "v0.0.13"
}
```

`configure-tunnel.sh` validates its first argument against `^tunnel_[A-Za-z0-9_-]+$`, creates `runtime`, writes JSON with `printf '{"tunnelId":"%s"}\n' "$tunnel_id" > "$ROOT/runtime/tunnel.json"`, and runs `chmod 600` on that file. It never reads or writes `CONTROL_PLANE_API_KEY`.

- [ ] **Step 5: Run installer GREEN**

```bash
bash plugin/codespace/scripts/install-tunnel-client.sh
bash plugin/codespace/scripts/verify.sh --installer-only
```

Expected: zero exit and version output for v0.0.13.

- [ ] **Step 6: Commit**

```bash
git add plugin/codespace/config plugin/codespace/scripts/install-tunnel-client.sh \
  plugin/codespace/scripts/configure-tunnel.sh plugin/codespace/scripts/verify.sh
git commit -m "feat(codespace): pin tunnel runtime"
```

---

### Task 7: Add idempotent managed-runtime startup and dev-container lifecycle integration

**Files:**
- Create: `plugin/codespace/scripts/ensure-running.sh`
- Modify: `plugin/codespace/scripts/verify.sh`
- Modify: `.devcontainer/devcontainer.json`

**Interfaces:**
- Single startup entry: `ensure-running.sh --phase create|start|attach|manual`.
- Managed runtime alias/profile: `codespace`.

- [ ] **Step 1: Add failing static lifecycle assertions**

Extend `verify.sh --static` so Node parses `.devcontainer/devcontainer.json` and requires object-form `postCreateCommand`, `postStartCommand`, `postAttachCommand`, with both `existing` and `codespace` keys for every phase. Also assert the new bridge startup contains `--mcp-command` and does not contain `nohup` or `disown`.

Exact Node assertion body:

```js
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('.devcontainer/devcontainer.json', 'utf8'));
for (const phase of ['postCreateCommand', 'postStartCommand', 'postAttachCommand']) {
  const value = config[phase];
  if (!value || typeof value !== 'object' || Array.isArray(value)) process.exit(1);
  if (typeof value.existing !== 'string' || typeof value.codespace !== 'string') process.exit(1);
}
```

- [ ] **Step 2: Run static RED**

```bash
bash plugin/codespace/scripts/verify.sh --static
```

- [ ] **Step 3: Implement startup preflight**

`ensure-running.sh` must:

1. Parse only `--phase create|start|attach|manual`.
2. Fail immediately if `CONTROL_PLANE_API_KEY` is empty, printing only the variable name.
3. Resolve tunnel ID from `CODESPACE_TUNNEL_ID`, then `CONTROL_PLANE_TUNNEL_ID`, then `runtime/tunnel.json`.
4. If no tunnel ID exists, print: `Run plugin/codespace/scripts/configure-tunnel.sh with the tunnel ID shown in OpenAI Platform Tunnels.` and exit non-zero.
5. Run `install-tunnel-client.sh`.
6. Build with `npx tsc -p plugin/codespace/tsconfig.json` when `dist/server.js` is absent or any `src/*.ts` file is newer.
7. Run the MCP integration test before connecting the tunnel.

- [ ] **Step 4: Implement managed runtime connect and status verification**

Execute:

```bash
"$TUNNEL_BIN" runtimes connect \
  --alias codespace \
  --tunnel-id "$TUNNEL_ID" \
  --profile codespace \
  --profile-dir "$ROOT/runtime/profiles" \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-command "bash $ROOT/scripts/start-mcp.sh"
```

Then capture:

```bash
"$TUNNEL_BIN" runtimes status codespace --json
```

A small Node parser must require the actual v0.0.13 status payload to prove all three semantics: process running, health healthy, readiness ready. If v0.0.13 nests these fields, first save one redacted status fixture under `tests/fixtures/runtime-status.json`, add a parser unit test, then use that tested parser in `ensure-running.sh`. Do not weaken the gate to process existence only.

Before connect, run `tunnel-client doctor` with the generated profile using only flags verified by `tunnel-client help doctor` on v0.0.13.

- [ ] **Step 5: Convert dev-container lifecycle to object form**

Preserve current commands verbatim:

```json
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
```

Do not remove or modify the current forwarded-port configuration in this task; the new bridge simply does not depend on it.

- [ ] **Step 6: Run GREEN**

```bash
bash plugin/codespace/scripts/verify.sh --static
bash plugin/codespace/scripts/ensure-running.sh --phase manual
plugin/codespace/runtime/bin/tunnel-client runtimes status codespace --json
```

Expected: startup zero exit and final line exactly:

```text
[codespace] READY: MCP integration, managed tunnel process, health, and readiness gates passed.
```

- [ ] **Step 7: Commit**

```bash
git add plugin/codespace/scripts/ensure-running.sh plugin/codespace/scripts/verify.sh .devcontainer/devcontainer.json
git commit -m "feat(codespace): add managed tunnel lifecycle"
```

---

### Task 8: Full acceptance, restart repair, and regression verification

**Files:**
- Modify only files implicated by an observed failing gate.

**Interfaces:**
- Completion is evidence-driven; no success claim before all checks below pass.

- [ ] **Step 1: Run complete local bridge verification**

```bash
npx tsc -p plugin/codespace/tsconfig.json
npx vitest run plugin/codespace/tests
bash plugin/codespace/scripts/verify.sh --static
```

- [ ] **Step 2: Configure the existing remote tunnel once if neither environment variable nor runtime config is present**

```bash
bash plugin/codespace/scripts/configure-tunnel.sh "$CODESPACE_TUNNEL_ID"
```

The operator exports `CODESPACE_TUNNEL_ID` from the ID shown on the existing `Codespace` tunnel page. The API key is never pasted into a shell command, chat message, or tracked file.

- [ ] **Step 3: Prove managed runtime readiness**

```bash
bash plugin/codespace/scripts/ensure-running.sh --phase manual
plugin/codespace/runtime/bin/tunnel-client runtimes status codespace --json
```

Require running + healthy + ready.

- [ ] **Step 4: Prove automatic repair after a stopped runtime**

```bash
plugin/codespace/runtime/bin/tunnel-client runtimes stop codespace
bash plugin/codespace/scripts/ensure-running.sh --phase manual
plugin/codespace/runtime/bin/tunnel-client runtimes status codespace --json
```

Require running + healthy + ready again, using the same remote tunnel identity.

- [ ] **Step 5: Run existing repository regression suite**

```bash
npm run build
npm test
```

- [ ] **Step 6: Configure ChatGPT custom plugin**

Use exactly:

```text
Name: codespace
Connection: Tunnel
Tunnel: Codespace
```

Leave Server URL unused.

- [ ] **Step 7: Run ChatGPT smoke calls through the new plugin**

Call:

```text
codespace_status
read_file with path package.json
execute_command with command pwd
execute_command with command git status --short
execute_command with command printf %s "${CONTROL_PLANE_API_KEY-unset}"
```

Acceptance requires:

```text
workspace path is the active /workspaces repository
read_file succeeds
pwd reports that workspace
Git command executes there
credential probe returns unset
```

- [ ] **Step 8: Commit only evidence-backed fixes made during acceptance**

```bash
git status --short
git add plugin/codespace .devcontainer/devcontainer.json .gitignore
git diff --cached --check
```

If the staged diff is non-empty, commit:

```bash
git commit -m "fix(codespace): close acceptance gaps"
```

If the staged diff is empty, do not create an empty commit.

- [ ] **Step 9: Completion rule**

Report `codespace v0.1 READY` only when every line is proven:

```text
TypeScript build PASS
bridge unit tests PASS
MCP stdio integration PASS
workspace boundary PASS
tunnel-client v0.0.13 checksum/version PASS
managed runtime running PASS
managed runtime health PASS
managed runtime readiness PASS
restart repair PASS
existing repository build PASS
existing repository tests PASS
ChatGPT tool discovery PASS
ChatGPT file read PASS
ChatGPT command PASS
credential non-exposure PASS
```
