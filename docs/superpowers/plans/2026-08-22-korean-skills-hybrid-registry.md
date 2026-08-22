# Korean Skills Hybrid Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone `J-nowcow/awesome-korean-agent-skills` under Commander, account for every catalog item in a canonical registry, and expose deferred capability discovery/loading through the existing Commander MCP/plugin.

**Architecture:** Keep the upstream catalog as an untouched Git clone under the stable project root. Parse its category tables into provenance-preserving records, serve compact search/recommend/get/coverage results from a registry service, and allow full instruction loading only for audited `native_ready` skills. Generated/cache/quarantine data remains outside Git source control.

**Tech Stack:** Node.js 24, TypeScript 7, MCP SDK 1.30, Zod 4, Vitest 4, Git CLI.

**Spec:** `docs/superpowers/specs/2026-08-22-korean-skills-hybrid-registry-design.md`

## Global Constraints
- All capability storage lives below `F:\Projects\Commander-MCP\capabilities`.
- The upstream catalog clone is never modified by Commander.
- Catalog CC0 does not confer license rights over external linked sources.
- No external source becomes `native_ready` before source, function, license, and safety audits pass.
- Hooks remain disabled by default; commands remain manual-only unless separately approved.
- Registry publication is atomic and a failed generation cannot destroy the prior good registry.
- Existing OAuth, tunnel, and 17 operational MCP tools must remain green.
- Secrets, runtime OAuth data, source caches, quarantine, and generated plugin artifacts are not committed.

---
### Task 1: Stable capability root and source clone

**Files:**
- Modify: `src/config.ts`
- Modify: `Start-Commander-MCP.bat`
- Modify: `.gitignore`
- Test: `tests/config.test.ts`
- Runtime create: `F:\Projects\Commander-MCP\capabilities\sources\awesome-korean-agent-skills`

**Interfaces:**
- Produces `AppConfig.capabilityDir: string`.
- Production launcher sets `COMMANDER_CAPABILITY_DIR=F:\Projects\Commander-MCP\capabilities` by default.

- [ ] **Step 1: Write failing config tests** asserting default/override `capabilityDir` behavior.
- [ ] **Step 2: Run `npm test -- tests/config.test.ts`** and verify failure because `capabilityDir` does not exist.
- [ ] **Step 3: Add `capabilityDir` to configuration** from `COMMANDER_CAPABILITY_DIR` with `path.resolve` normalization.
- [ ] **Step 4: Re-run config tests and full build**; expect green.
- [ ] **Step 5: Clone the catalog** using `git clone --filter=blob:none https://github.com/J-nowcow/awesome-korean-agent-skills.git F:\Projects\Commander-MCP\capabilities\sources\awesome-korean-agent-skills`, or fast-forward it if already present, then record `git rev-parse HEAD`.
- [ ] **Step 6: Commit source/config changes** with `feat: add stable capability storage root`.

### Task 2: Canonical catalog parser and coverage generator

**Files:**
- Create: `src/capabilities/types.ts`
- Create: `src/capabilities/catalog-parser.ts`
- Create: `src/capabilities/registry-writer.ts`
- Create: `scripts/sync-capabilities.mjs`
- Test: `tests/capability-parser.test.ts`
- Fixture: `tests/fixtures/capability-catalog/categories/debugging.md`

**Interfaces:**
- `parseCatalog(root, catalogSha): Promise<CapabilityRecord[]>`
- `writeRegistryGeneration(capabilityDir, records, metadata): Promise<CoverageReport>`
- Stable IDs derive from normalized source URL + capability type using SHA-256.

- [ ] **Step 1: Write failing parser tests** for Skill/Agent/Command/Hook rows, duplicate names, source URL extraction, compatibility/language parsing, and deterministic IDs.
- [ ] **Step 2: Run parser tests** and verify RED from missing parser/types.
- [ ] **Step 3: Implement minimal parser/types** that scan every `categories/*.md` table row and map section headings to canonical capability types.
- [ ] **Step 4: Add failing atomic-registry test** proving a rejected generation leaves the previous `catalog.json` untouched.
- [ ] **Step 5: Implement staged registry publication** with `catalog.json`, per-item JSON, `coverage.json`, and catalog SHA metadata.
- [ ] **Step 6: Run parser tests + build** and expect green.
- [ ] **Step 7: Run the real catalog sync/parser** and assert `coverage.total === catalog.items.length`, with every item having name/type/category/declaredPurpose/source/state.
- [ ] **Step 8: Commit** with `feat: index Korean agent capability catalog`.
### Task 3: Registry service and deferred recommendation

**Files:**
- Create: `src/capabilities/registry-service.ts`
- Modify: `src/runtime/services.ts`
- Test: `tests/capability-registry.test.ts`

**Interfaces:**
- `CapabilityRegistry.search(query, filters?)`
- `CapabilityRegistry.recommend(task, context?)`
- `CapabilityRegistry.get(id)`
- `CapabilityRegistry.coverage()`
- `CapabilityRegistry.loadSkill(id)` rejects anything not `native_ready`.

- [ ] **Step 1: Write failing service tests** for query/category/type/risk filtering, deterministic ranking, metadata-only recommendation, coverage, and native-ready load enforcement.
- [ ] **Step 2: Run `npm test -- tests/capability-registry.test.ts`** and verify RED.
- [ ] **Step 3: Implement the registry service** with tokenized lexical scoring over name, aliases, purpose, functional summary, category, triggers, and compatibility; never include full skill instructions in search/recommend.
- [ ] **Step 4: Re-run service tests and full build**; expect green.
- [ ] **Step 5: Wire the registry into `RuntimeServices`** using `config.capabilityDir` with graceful empty-registry behavior when no generated catalog exists.
- [ ] **Step 6: Commit** with `feat: add deferred capability registry service`.

### Task 4: One real source through license/function/safety normalization

**Files:**
- Create: `src/capabilities/source-audit.ts`
- Create: `src/capabilities/skill-normalizer.ts`
- Test: `tests/capability-audit.test.ts`
- Runtime output: `F:\Projects\Commander-MCP\capabilities\cache\sources\...`
- Runtime output: `F:\Projects\Commander-MCP\capabilities\normalized\skills\...`
- Runtime output: `F:\Projects\Commander-MCP\capabilities\provenance\...`

**Interfaces:**
- `auditSkillSource(input): Promise<SkillAudit>` records source SHA, license, function, dependencies, side effects, risk and eligibility.
- `normalizeAuditedSkill(audit): Promise<NormalizedSkill>` only accepts `license_verified + function_analyzed + safety_reviewed` inputs.

- [ ] **Step 1: Write failing audit/normalizer tests** using local fixture source + LICENSE for permissive, unknown-license, and dangerous-hook cases.
- [ ] **Step 2: Run audit tests** and verify RED.
- [ ] **Step 3: Implement source audit and normalization gates**; source text is preserved, summaries are separate metadata, and high/unknown risk cannot become native-ready.
- [ ] **Step 4: Resolve one real catalog Skill from a directly linked `SKILL.md` whose repository license is explicitly permissive; prefer an `anthropics/skills` catalog entry when present. If none is present in the parsed catalog, select the first direct Skill source with an SPDX-recognizable permissive license. Do not substitute unknown-license material.**
- [ ] **Step 5: Cache exact source + license + commit SHA, analyze actual instructions, generate normalized native skill metadata, and update only that item's registry state to `native_ready`.**
- [ ] **Step 6: Re-run audit tests, parser coverage validation, and build**; expect green.
- [ ] **Step 7: Commit source-code changes only** with `feat: audit and normalize native skill candidates`; runtime caches/normalized generated artifacts remain ignored.
### Task 5: MCP capability tools and router surface

**Files:**
- Create: `src/mcp/capability-tools.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/mcp-capabilities.test.ts`

**Interfaces:**
- MCP tools: `capability_recommend`, `capability_search`, `capability_get`, `skill_load`, `capability_dependencies`, `capability_coverage`.
- All six tools are read-only/non-destructive; `skill_load` returns instructions only for `native_ready` skills.

- [ ] **Step 1: Write failing MCP discovery tests** asserting the 17 operational tools remain present plus six capability tools with read-only annotations.
- [ ] **Step 2: Write failing call tests** for recommendation, search, get, coverage and rejected non-native skill load.
- [ ] **Step 3: Run MCP capability tests** and verify RED.
- [ ] **Step 4: Register six capability tools** with bounded schemas/results and no unrelated instruction expansion.
- [ ] **Step 5: Update server version/capability report** to the hybrid-registry release while preserving existing auth/workspace behavior.
- [ ] **Step 6: Run MCP tests + all regression tests + build** and expect green.
- [ ] **Step 7: Commit** with `feat: expose deferred capability discovery over mcp`.

### Task 6: Commander plugin packaging workspace and live acceptance

**Files:**
- Create: `plugin/commander/skills/commander-capability-router/SKILL.md`
- Create: `plugin/commander/README.md`
- Create: `scripts/build-plugin-package.mjs`
- Modify: `README.md`
- Modify: `.gitignore`
- Test: `tests/plugin-package.test.ts`

**Interfaces:**
- Router skill instructs ChatGPT to perform compact preflight with `capability_recommend`, inspect risk/dependencies, call `skill_load` only after selection, and execute through the existing Commander app tools.
- Generated native-ready skill copies are sourced only from audited local normalized material.

- [ ] **Step 1: Write failing package tests** checking router skill presence, no unaudited skill packaging, provenance references, and generated app/tool documentation.
- [ ] **Step 2: Run package tests** and verify RED.
- [ ] **Step 3: Implement package builder and router skill** with deferred loading rules from the approved spec.
- [ ] **Step 4: Build package and verify** only audited native-ready skills are included; registry/cache/quarantine/secrets are excluded.
- [ ] **Step 5: Run full `npm test` + `npm run build`**; expect all green.
- [ ] **Step 6: Restart production Commander** against stable runtime/capability directories and verify live `tools/list` contains the original 17 plus six capability tools.
- [ ] **Step 7: Live-call `capability_coverage`, `capability_recommend`, and the one audited `skill_load`** using production credential without printing secrets.
- [ ] **Step 8: Verify tunnel `/readyz` is HTTP 200 and Git status contains no secret/cache/quarantine artifacts.**
- [ ] **Step 9: Commit** with `feat: package Commander capability router plugin`.

## Plan Self-Review
- Spec coverage: storage, state gating, full catalog accounting, deferred selection, one real audited skill, MCP primitives, plugin router, regression/live acceptance are all assigned to explicit tasks.
- Placeholder scan: no TBD/TODO/"implement later" instructions are present.
- Type consistency: `AppConfig.capabilityDir`, `CapabilityRegistry`, six MCP capability names, and audit/normalize gates are consistent across tasks.
- Scope: external repositories are not bulk-cloned; only one real Skill must complete the native-ready pipeline in this release, while all catalog rows remain searchable/accounted for.
