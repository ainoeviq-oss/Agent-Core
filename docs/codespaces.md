# Agent Core on GitHub Codespaces

Agent Core can run as a second, isolated MCP target inside GitHub Codespaces while the Windows/local deployment remains unchanged.

## Automatic lifecycle

The tracked `.devcontainer/devcontainer.json` owns recovery:

- **postCreate** — detect/install known prerequisites, reconcile npm dependencies, run a full build, create non-leaking Codespace auth state if missing, start Agent Core, repair port forwarding, and verify public MCP/OAuth health.
- **postStart** — validate dependencies, run a full build, restore the runtime supervisor, repair port `8765`, and re-verify the connection.
- **postAttach** — run a fast health-first repair; rebuild only when `dist/` is missing/stale or a dependency marker is missing.

Runtime data is kept under `/workspaces/.agent-core-codespace`, which survives normal Codespace stop/start and container rebuilds because it remains inside `/workspaces`.

## Check current MCP URL

```bash
npm run codespace:connection
```

The same verified URL is stored in:

```text
/workspaces/.agent-core-codespace/mcp-url.txt
```

This is the URL to copy into the ChatGPT custom plugin named `Agent Core Codespace`.

## Manual repair

```bash
npm run codespace:repair
```

## Manual full bootstrap

```bash
npm run codespace:bootstrap
```

The bootstrap installs only known required tools and dependencies. It does not infer arbitrary packages from error text.

## Reveal the API key only when OAuth requires it

```bash
cat /workspaces/.agent-core-codespace/secrets/agent-core-chatgpt-key.txt
```

Do not paste this key into chat or commit it. Automatic lifecycle scripts never print the key value.

## Native GitHub Fabric in Codespaces

When Codespaces exposes `GITHUB_TOKEN` or `gh auth token`, bootstrap writes that credential to the ignored Agent Core GitHub credential file with mode `0600` without printing it. This lets the Codespace instance use the same Native GitHub Fabric contract as the local instance while keeping credentials out of Git.

An optional dedicated GitHub Packages credential can be supplied through `AGENT_CORE_GITHUB_PACKAGES_TOKEN`.

## URL policy

The automation reports a verified URL but never edits ChatGPT custom plugin settings.

For the current Codespace the direct endpoint follows the GitHub forwarded-port address. As long as the same Codespace identity remains, the plugin URL remains unchanged across disconnect/reconnect, stop/start, and rebuild.

If a Codespace is completely deleted and recreated with a different hostname, run:

```bash
npm run codespace:connection
```

and replace the plugin URL manually once.

## Optional stable front door

A future named tunnel/domain can become the public front door without changing the bootstrap architecture:

```bash
export AGENT_CORE_PUBLIC_BASE_URL=https://agent-core-codespace.example.com
npm run codespace:repair
```

When this variable is set, Agent Core verifies and reports that explicit base URL rather than silently switching plugin targets.

## Health and security gates

A connection is marked `READY` only after all required checks pass:

1. local Agent Core health on `127.0.0.1:8765`;
2. memory, continuity, and execution health;
3. Codespaces port `8765` registered;
4. port visibility is `public`;
5. public `/health` succeeds;
6. OAuth issuer matches the verified public base URL;
7. unauthenticated `/mcp` returns `401`;
8. `connection.json` and `mcp-url.txt` are written atomically.

No success banner is emitted after a failed gate.

## Linux command execution

Agent Core chooses the command shell by operating system:

```text
Windows -> powershell.exe -NoLogo -NoProfile -NonInteractive -Command
Linux   -> /bin/bash -lc
```

The execution scheduler, evidence hashing, process ownership, workspace restrictions, timeouts, and blocked-command policy remain shared across both platforms.

## Local-only verification policy

Codespace verification is performed inside the Codespace. GitHub Actions/CI is not used for Agent Core verification or publication.
