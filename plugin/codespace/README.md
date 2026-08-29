# codespace

`codespace` is the zero-touch ChatGPT ↔ GitHub Codespaces bridge in this repository.

## Fresh Codespaces without collaborator access

The bridge uses a GitHub **user-level Codespaces secret** named `CONTROL_PLANE_API_KEY` for first boot. This secret belongs to the GitHub account that creates the Codespace, so the account does not need collaborator access to the parent repository.

Run the installer once for each GitHub account/repository pair:

```bash
bash plugin/codespace/scripts/install-account-codespaces-secret.sh
```

The installer:

- reads the existing runtime credential from `secrets/github/CONTROL_PLANE_API_KEY` unless `--key-file` is supplied;
- resolves the current `origin` repository automatically, or accepts `--repo OWNER/REPO`;
- stores the value as a GitHub user-level Codespaces secret restricted to that repository;
- sends the value through stdin so it is not placed in argv, shell history, or process listings;
- never prints the credential value.

After this one-time account bootstrap, every newly created Codespace for the selected repository receives `CONTROL_PLANE_API_KEY` automatically. `plugin/codespace/scripts/ensure-running.sh` persists it into ignored workspace state with mode `0600`, reconstructs the fixed tunnel identity from tracked configuration, restores plugin dependencies/build output when needed, and verifies local plus remote readiness.

## Automatic runtime architecture

The normal managed route is:

```text
ChatGPT connector
  → fixed OpenAI tunnel
  → tunnel-client managed runtime
  → http://127.0.0.1:38765/mcp
  → Codespace MCP tools
```

The MCP HTTP listener is bound to loopback only. It is not a public Codespaces port. The previous stdio entrypoint remains available as a tested fallback, but it is not used by the managed tunnel because tunnel-client cannot perform a real startup probe for stdio targets.

Every canonical Codespaces lifecycle phase performs the following automatically:

1. recover the persistent credential file and fixed tunnel identity;
2. restore dependencies and compiled output when absent;
3. start or reconcile the loopback Streamable HTTP MCP server;
4. complete a real MCP initialize and tool-list exchange;
5. reconnect the fixed tunnel and verify structured local/remote status;
6. confirm the managed target is the expected loopback HTTP URL;
7. start the independent self-healing watchdog;
8. declare `READY` only after all gates pass.

## Self-healing behavior

The watchdog runs in its own bridge-owned tmux session and checks:

- loopback MCP health;
- tunnel process, readiness, staleness, fixed tunnel identity, remote registration, and target URL;
- newly appended tunnel log events.

It performs one serialized, cooldown-protected reconnect when the MCP service dies, the managed runtime becomes invalid, or three consecutive internal `502` events show that the connector route is poisoned. A successful forwarded command resets the failure streak. Historical log failures are ignored when the watcher first starts.

Repair never resets, cleans, stashes, restores, or rewrites project work. Credential values are not printed, committed, or inherited by the MCP and watchdog child processes.

## Normal use

No tunnel, export, stop, reconnect, or repair command is expected after account bootstrap. Create, restart, rebuild, or resume the Codespace, then use the `codespace` connector from ChatGPT. When a transient connector failure occurs, ChatGPT may retry while the watchdog repairs the route automatically; the user-facing action remains simply:

```text
test koneksi
```

The fixed tunnel identity is tracked in `plugin/codespace/config/tunnel.defaults.json`. Runtime state, generated profiles, binaries, logs, node modules, compiled output, and credentials remain untracked.
