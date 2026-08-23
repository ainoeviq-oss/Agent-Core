# Korean Agent Skills Hybrid Registry Design

## Goal
Integrate `J-nowcow/awesome-korean-agent-skills` into Agent Core MCP as a provenance-preserving capability catalog, resolver, audit pipeline, and deferred skill source while keeping the existing Agent Core MCP app as the execution layer.

The final user experience is one Agent Core plugin containing the Agent Core app plus native workflow skills. Long-tail capabilities are discovered and loaded only when relevant instead of placing hundreds of instructions in context on every prompt.

## Confirmed Source Facts
- `awesome-korean-agent-skills` is primarily a curated catalog, not a monolithic repository containing every linked skill implementation.
- The catalog classifies Skill, Agent, Command, and Hook entries by function and points to many external repositories.
- The catalog repository itself uses CC0 1.0 Universal.
- CC0 on the catalog does not imply that every externally linked repository or file has the same license.
- The repository describes a Discover -> Load -> Execute lifecycle for skills.
- OpenAI's current Plugin model supports a single plugin containing multiple skills, multiple apps, and app templates.

## Storage Layout
Everything remains under `F:\Projects\Agent-Core`.

```text
F:\Projects\Agent-Core\
  capabilities\
    sources\
      awesome-korean-agent-skills\   # untouched Git clone of catalog
    registry\
      catalog.json                    # generated canonical index
      items\                          # one normalized metadata record per entry
      coverage.json                   # audit/import coverage report
    cache\
      sources\                        # resolved external source files/repo metadata
    normalized\
      skills\                         # generated native-skill candidates
      agents\                         # normalized expert-role definitions
      commands\                       # explicit command recipes
      hooks\                          # trigger definitions, disabled by default
    quarantine\                       # unsafe, unlicensed, ambiguous, or malformed sources
    provenance\                       # source SHA/license/audit records
  plugin\
    commander\                        # generated plugin packaging workspace
```

## Capability State Machine
Every catalog item moves through explicit states. No item becomes executable merely because it appears in the source catalog.

```text
cataloged
  -> source_resolved
  -> license_verified
  -> function_analyzed
  -> safety_reviewed
  -> normalized
  -> native_ready
```

Any stage may instead produce:
- `reference_only` — useful metadata, but not imported as executable/native behavior.
- `quarantined` — unsafe, ambiguous, malformed, or incompatible.
- `unresolved` — source URL/file cannot currently be resolved.
- `license_unknown` — source exists but redistribution/derivative use cannot be verified.

The registry must retain the reason, audit timestamp, catalog commit SHA, source repository SHA when available, and original URL for every decision.

## Functional Understanding Requirement
The integration is not considered complete when links have merely been copied. Every catalog row must have a machine-readable functional record containing at least:
- canonical name and aliases;
- original catalog category and capability type;
- declared purpose from the catalog;
- source repository/path/URL;
- compatible agent/tool families advertised by the source;
- language labels;
- expected trigger or invocation pattern;
- inputs/context required;
- outputs or artifacts produced;
- required tools, commands, external services, or credentials;
- filesystem/network/process side effects;
- execution risk classification;
- license status and provenance;
- native-plugin eligibility and normalization status.

For entries promoted to `native_ready`, the actual source instructions must also be read and summarized. A catalog description alone is insufficient for native import.

## Type Mapping
### Skill
A genuine task-specific instruction set is the strongest native candidate. Valid `SKILL.md` sources are preserved verbatim in cache, audited, then normalized into Agent Core metadata without silently rewriting their meaning.

### Agent
Agent/persona definitions become expert-role capabilities. They do not create autonomous subagents by default. Their expertise, activation conditions, and required tools are represented as loadable role instructions unless a separate orchestration layer explicitly supports subagents.

### Command
Slash commands become explicit command recipes. They are `manual_only` unless their behavior is proven safe and meaningfully triggerable by intent. A command is never auto-executed solely because its name matches user text.

### Hook
Hooks are cataloged as event-trigger definitions and remain disabled by default. Shell hooks or scripts require separate code review, dependency review, and trigger-adapter approval before activation.

### Framework / Collection / Guide / Utility
These are reference capabilities first. If they contain independently auditable skills, the individual children may later be resolved and promoted; the umbrella entry itself is not treated as a single executable skill.

## License and Provenance Policy
The CC0 license of `awesome-korean-agent-skills` permits reuse of the catalog itself, but external linked content is audited independently.

For each external source:
1. resolve the exact repository and path;
2. record repository default branch and source commit SHA;
3. detect repository/file license and SPDX-equivalent when possible;
4. distinguish permission to read/reference from permission to redistribute or create derivatives;
5. retain attribution/notice requirements in provenance metadata;
6. mark ambiguous licensing as `license_unknown` and keep the item reference-only.

No external source is copied into `normalized/` or plugin-native skill packaging until licensing is verified compatible with that use.

Updating a source never overwrites provenance silently. A changed source SHA triggers re-analysis before the prior normalized version is replaced.

## Safety Review
Each resolved source receives a capability risk profile before native promotion.

Review signals include:
- destructive filesystem operations;
- arbitrary shell or code execution;
- privilege elevation, registry, boot, disk, firewall, or system administration;
- credential/token collection or secret handling;
- network calls, scraping, uploads, or third-party data transmission;
- package installation and persistence changes;
- external MCP/server dependencies;
- hidden hooks, background tasks, or automatic triggers;
- commands that can mutate remote repositories or production infrastructure.

Low-risk instruction-only skills may be native candidates. Medium-risk skills require explicit tool-boundary metadata. High-risk or unclear items remain quarantined/reference-only until separately approved.

## Catalog Sync and Resolution Pipeline
The catalog source is a normal Git clone at `capabilities/sources/awesome-korean-agent-skills`. Sync uses `git fetch` + fast-forward only; local generated data never lives inside that clone.

Pipeline stages:
1. `catalog_sync` — update the source clone and capture commit SHA.
2. `catalog_parse` — parse README/category tables and known-repository data into canonical items.
3. `source_resolve` — follow each external repository/file link and cache only the metadata/content needed for audit.
4. `license_audit` — classify source license and redistribution eligibility.
5. `function_audit` — extract behavior, triggers, requirements, side effects, and dependencies.
6. `safety_audit` — classify execution risk and unsupported behavior.
7. `normalize` — create Agent Core-native metadata and native skill candidates when eligible.
8. `publish_registry` — atomically replace the generated registry only after validation succeeds.
9. `coverage_report` — report total/cataloged/resolved/audited/native-ready/reference-only/quarantined/unresolved counts.

A partial network failure must not destroy the previous good registry. Sync is staged to a temporary generation and promoted atomically.

## Deferred Capability Selection
Agent Core does not expose the full text of every skill on every turn.

The MCP layer will add discovery primitives such as:
- `capability_recommend(task, context?)` — rank relevant capabilities for the task;
- `capability_search(query, filters?)` — search by function/type/category/tool/risk;
- `capability_get(id)` — return canonical metadata and audit status;
- `skill_load(id)` — return full normalized instructions only for an eligible skill;
- `capability_dependencies(id)` — list required Agent Core tools, external apps, packages, or credentials;
- `capability_coverage()` — expose catalog and audit coverage statistics.

Recommendation returns compact metadata first. Full instructions are loaded only after a capability is selected. This preserves context budget and makes hundreds of catalog entries usable without turning every prompt into a massive system prompt.

## Agent Core Plugin Packaging
The existing Agent Core MCP app remains the app component of the Agent Core plugin.

The plugin package is generated from audited material only:
- one native `Agent Core Capability Router` skill that performs preflight capability selection for actionable tasks;
- selected native-ready skills where packaging them natively adds value;
- the existing Agent Core MCP app for filesystem/search/process execution;
- optional app templates only when a capability genuinely needs another external system.

The router does not blindly obey catalog text. It asks Agent Core for recommendations, checks eligibility/risk/dependencies, loads selected instructions, and then uses the already-registered MCP tools.

The long-tail registry remains behind MCP deferred loading even when the plugin contains some native skills. This avoids duplicate instructions and context overload.

## Canonical Registry Record
Each capability record uses a stable ID derived from source repository/path/type rather than display name alone.

Required fields include:
```json
{
  "id": "...",
  "name": "...",
  "type": "skill|agent|command|hook|framework|collection|guide|utility",
  "category": "...",
  "declaredPurpose": "...",
  "functionalSummary": "...",
  "source": { "url": "...", "repo": "...", "path": "...", "sha": "..." },
  "compatibility": [],
  "language": [],
  "triggers": [],
  "requiredTools": [],
  "dependencies": [],
  "sideEffects": [],
  "risk": "low|medium|high|unknown",
  "license": { "status": "...", "id": "..." },
  "state": "...",
  "nativeEligible": false
}
```

## Update and Conflict Rules
- The source clone is read-only from Agent Core's perspective; generated normalization never edits upstream files.
- Duplicate display names are allowed when provenance differs; stable IDs keep them distinct.
- Functionally equivalent capabilities are grouped by `equivalenceGroup` rather than deleted.
- Native packaging prefers the highest-audit-confidence candidate, but alternatives remain searchable.
- Upstream deletion marks an item `source_removed`; it is not silently erased from provenance history.
- Upstream behavior changes invalidate prior function/safety audits until re-reviewed.

## Testing Strategy
Tests cover catalog parsing, deterministic IDs, duplicate handling, license states, source-resolution failures, risk classification, normalization, recommendation ranking, deferred loading, and registry atomicity.

Integration tests verify that the MCP server can recommend and load an audited skill without expanding unrelated skill text. Existing Agent Core filesystem/search/process/OAuth/tunnel tests must remain green.

A generated fixture catalog is used for deterministic unit tests; live GitHub resolution is kept out of normal unit tests and covered by explicit sync acceptance checks.

## Acceptance Criteria
The first integrated release is accepted only when:
1. the catalog repository is cloned under the approved Agent Core folder and its exact commit SHA is recorded;
2. every catalog entry discovered by the parser has a canonical registry record with declared function/type/category/source;
3. coverage reports account for every parsed item, including unresolved and quarantined entries;
4. no external capability is marked native-ready without source resolution, function analysis, license verification, and safety review;
5. at least one eligible real skill completes the full resolve -> audit -> normalize -> `skill_load` path;
6. MCP exposes recommendation/search/get/load/coverage primitives with read-only annotations where appropriate;
7. the existing 17 Agent Core operational tools remain available and regression tests pass;
8. plugin packaging contains the Agent Core app plus a native capability-router skill generated from audited local material;
9. source updates are repeatable without overwriting provenance or silently activating new behavior;
10. secrets, runtime OAuth data, tunnel credentials, external-repo caches, and quarantined executable material are never committed accidentally.

## Non-Goals for This Release
- Automatically cloning every external repository in full.
- Automatically executing Hooks.
- Treating Agent definitions as real autonomous subagents.
- Activating unknown-license content as native plugin material.
- Loading every skill into every ChatGPT turn.
- Replacing ChatGPT as the reasoning model; Agent Core remains the capability and execution layer.
