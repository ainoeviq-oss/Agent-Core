# Agent Core Plugin Source

This directory contains the tracked, reproducible source for the Agent Core plugin layer: the native Capability Router skill plus metadata that binds it to the already-connected Agent Core MCP app.

## Tracked core

```text
plugin/agent-core/
├── README.md
└── skills/
    └── agent-core-capability-router/
        └── SKILL.md
```

The tracked core is intentionally small. It does not vendor OAuth state, API credentials, runtime databases, local capability caches, or third-party skill sources.

## Local audited expansion

On a workstation with the local audited capability registry available, run:

```powershell
npm run build:plugin
```

The builder materializes the native router plus only capabilities that passed the required source, license, function-analysis and safety gates. Each generated third-party skill carries its audited provenance and license evidence.

Generated output is local and ignored by Git.

## Stable release package

The stable release workflow packages the **tracked core** rather than depending on untracked local registry state. This keeps tagged release assets reproducible from the repository alone.

The published plugin source package contains:

- the native Agent Core Capability Router skill;
- release/package metadata;
- plugin documentation and changelog;
- no credentials, runtime state, local capability registry, quarantine material, or raw logs.

Additional audited skills remain dynamically available through Agent Core's capability registry and are not silently vendored into the stable GitHub Package.

## Runtime contract

The native router treats capability routing as an internal preflight for actionable work:

1. establish a principal/project route;
2. rehydrate relevant memory/continuity state;
3. inspect required capability dependencies;
4. load full instructions only for audited `native_ready` skills;
5. reuse the route context for route-bound operations that belong to the same coherent goal.

Users should not need to manually manage route IDs during normal use.

## ChatGPT boundary

Agent Core's app component remains the existing authenticated MCP connection. The plugin source does not invent or embed a second app credential. Skills and app connectivity are separate concerns: credentials stay in the runtime/app boundary, while this directory carries only the safe plugin source layer.
