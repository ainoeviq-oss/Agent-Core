# Agent Core Plugin Source

This directory contains the tracked, reproducible source for the Agent Core plugin layer: native operating skills plus metadata that binds them to the already-connected Agent Core MCP app.

## Tracked core

```text
plugin/agent-core/
├── README.md
└── skills/
    ├── agent-core-capability-router/
    │   └── SKILL.md
    └── agent-core-github/
        └── SKILL.md
```

The tracked core is intentionally small. It does not vendor OAuth state, API credentials, runtime databases, local capability caches, transient Git/npm authentication material, or third-party skill sources.

## Native GitHub Fabric

`agent-core-github` teaches connected clients how to use Agent Core's native GitHub tool surface:

- repository operations through `github_repo`;
- authenticated HTTPS Git through `github_git`;
- issues and pull requests through `github_issue` and `github_pr`;
- workflows through `github_actions`;
- releases through `github_release`;
- package operations through `github_packages`;
- same-origin REST escape-hatch calls through `github_api`.

Authentication remains a runtime concern. The plugin skill contains no GitHub credential value and does not require `gh auth login`. Agent Core reads configured local credential files lazily and keeps credential material out of plugin/release artifacts.

## Local audited expansion

On a workstation with the local audited capability registry available, run:

```powershell
npm run build:plugin
```

The builder materializes both tracked core skills plus only third-party capabilities that passed the required source, license, function-analysis and safety gates. Each generated third-party skill carries its audited provenance and license evidence.

Generated output is local and ignored by Git.

## Stable release package

The stable release workflow packages the **tracked core** rather than depending on untracked local registry state. This keeps tagged release assets reproducible from the repository alone.

The published plugin source package contains:

- the native Agent Core Capability Router skill;
- the native Agent Core GitHub skill;
- release/package metadata;
- plugin documentation and changelog;
- no credentials, runtime state, local capability registry, quarantine material, transient authentication files, or raw logs.

Additional audited skills remain dynamically available through Agent Core's capability registry and are not silently vendored into the stable GitHub Package.

## Runtime contract

The native router treats capability routing as an internal preflight for actionable work:

1. establish a principal/project route;
2. rehydrate relevant memory/continuity state;
3. inspect required capability dependencies;
4. load full instructions only for audited `native_ready` skills;
5. reuse the route context for route-bound operations that belong to the same coherent goal.

The GitHub skill then chooses the narrowest GitHub tool appropriate to the routed intent. Read-only routes are not reused for GitHub mutations, and guarded destructive operations require explicit user intent plus the runtime confirmation gate.

Users should not need to manually manage route IDs or GitHub login state during normal use.

## ChatGPT boundary

Agent Core's app component remains the existing authenticated MCP connection. The plugin source does not invent or embed a second app credential. Skills and app connectivity are separate concerns: credentials stay in the runtime/app boundary, while this directory carries only safe plugin guidance and reproducible metadata.
