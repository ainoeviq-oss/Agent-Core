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

After this one-time account bootstrap, every newly created Codespace for the selected repository receives `CONTROL_PLANE_API_KEY` automatically. `plugin/codespace/scripts/ensure-running.sh` then persists it into ignored workspace state with mode `0600`, reconstructs the fixed tunnel identity from tracked configuration, restores plugin dependencies/build output when needed, reconnects the runtime, and verifies local plus remote readiness.

## Normal use

No manual tunnel commands are expected after account bootstrap. Create or restart the Codespace and use the `codespace` connector from ChatGPT.

The fixed tunnel identity is tracked in `plugin/codespace/config/tunnel.defaults.json`. Runtime state, generated profiles, binaries, and credentials remain untracked.
