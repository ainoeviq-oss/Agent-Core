# Approval Record

**Approved by user:** 2026-08-27
**Implementation authorization:** Full approval to proceed with the plan; implementation decisions may be made without repeated confirmation.

> The plan below is preserved verbatim as the original review record. Its internal "DRAFT FOR REVIEW" status reflects the moment it was authored; this approval header supersedes that gate.

---
# PLAN — PPTX → Keynote + Google Slides Converter
**Status:** DRAFT FOR REVIEW — **NO IMPLEMENTATION / NO INTEGRATION STARTED**
**Project type:** Fresh standalone project
**Working name:** `Presentation-Bridge` *(name can be changed during review)*
**Prepared:** 2026-08-27
**Primary rule:** This project must be isolated from every existing project. No shared runtime, database, secrets, source tree, or hidden dependency on another project.

---

## 0. Review Gate

This document is the source-of-truth plan for the first implementation phase.

**Nothing in this plan authorizes implementation yet.**

Implementation begins only after explicit user approval of this plan.

Until approval:

- do not create the project repository/folder;
- do not install dependencies;
- do not register Google OAuth credentials;
- do not configure a macOS worker;
- do not write converter code;
- do not modify any existing project;
- do not reuse code/config/secrets/database from another project.

---

# 1. Product Objective

Build a standalone conversion system whose single purpose is:

```text
INPUT
.pptx

OUTPUT A
Native Keynote presentation (.key)

OUTPUT B
Native Google Slides presentation

PLUS
Conversion / fidelity / compatibility evidence
```

The system must convert PowerPoint presentations while preserving as much as technically possible of:

- slide dimensions;
- slide order;
- layouts;
- masters/themes;
- text;
- typography;
- colors;
- fills;
- strokes;
- shapes;
- images;
- crops;
- transparency;
- gradients;
- groups;
- tables;
- charts;
- hyperlinks;
- speaker notes;
- transitions;
- animations;
- media;
- object placement and geometry.

The product must not claim a conversion is successful merely because the source PPTX can be opened by the target platform.

A successful conversion must produce a **native target artifact**.

---

# 2. Hard Project Isolation Rules

The converter is a completely new project.

## Required isolation

The project must have its own:

- source folder / repository;
- package manifest;
- dependency tree;
- configuration;
- environment variables;
- local runtime folder;
- logs;
- temporary conversion workspace;
- Google OAuth configuration;
- worker configuration;
- test corpus;
- documentation;
- release artifacts.

## Forbidden coupling

It must not depend on:

- Agent Core;
- Market Signal Lab;
- n8n;
- NeuraCore;
- any previous converter;
- another project's SQLite database;
- another project's secrets;
- another project's runtime folders;
- another project's launcher;
- another project's port assignments;
- symlinked project code;
- hidden environment assumptions from an existing project.

If an external application is required, such as Keynote on macOS, it is treated as an **external platform dependency**, not as another project dependency.

---

# 3. Product Philosophy

The project should not be designed as a naïve file extension converter.

The correct model is:

```text
              ┌──────────────────────┐
PPTX ────────►│ Conversion Orchestrator│
              └──────────┬───────────┘
                         │
             ┌───────────┴───────────┐
             │                       │
             ▼                       ▼
     Google Native Path       Keynote Native Path
             │                       │
             ▼                       ▼
       Google Slides              .key
             │                       │
             └───────────┬───────────┘
                         ▼
                Fidelity / QA Layer
                         │
                         ▼
                 Conversion Report
```

The target platform's own native importer should be used where it provides a stronger compatibility path than manually reconstructing every PowerPoint object.

A PPTX analyzer / intermediate representation is still valuable, but primarily for:

- preflight;
- compatibility prediction;
- object inventory;
- post-import verification;
- repair;
- fidelity scoring;
- diagnostics;
- future advanced conversion modes.

It should **not automatically become a full slide re-rendering engine** unless later evidence proves that necessary.

---

# 4. Verified Platform Facts Used by This Plan

## Google

Google Drive API officially supports importing Microsoft PowerPoint into Google Slides.

The converter should query Drive `about.importFormats` instead of hardcoding assumptions about conversion availability.

Target native MIME type:

```text
application/vnd.google-apps.presentation
```

The Google Slides API can then retrieve a presentation and apply atomic `batchUpdate` operations for bounded post-import repair.

## Apple Keynote

Apple officially supports opening Microsoft PowerPoint presentations in Keynote on Mac and saving presentations as Keynote documents.

The Keynote conversion path therefore should use a real macOS + Keynote runtime rather than reverse-engineering the `.key` package format.

## Important unresolved detail

Exact automation commands available in the installed Keynote version must be proven before implementation.

The project must not assume a specific AppleScript/JXA command contract until a macOS feasibility probe has inspected and successfully exercised the installed Keynote scripting surface.

---

# 5. Proposed System Architecture

```text
┌───────────────────────────────────────────────────────────┐
│                    Presentation Bridge                    │
├───────────────────────────────────────────────────────────┤
│  Input / Job API                                          │
│       │                                                   │
│       ▼                                                   │
│  PPTX Preflight + Analyzer                                │
│       │                                                   │
│       ├────────────► Presentation IR / Manifest            │
│       │                                                   │
│       ▼                                                   │
│  Conversion Orchestrator                                  │
│       │                                                   │
│       ├────────────► Google Slides Adapter                 │
│       │                    │                              │
│       │                    ├─ Drive import                │
│       │                    ├─ Slides inspection           │
│       │                    └─ bounded repair              │
│       │                                                   │
│       └────────────► Keynote Adapter                       │
│                            │                              │
│                            └─ macOS Conversion Worker     │
│                                   ├─ Keynote open PPTX    │
│                                   ├─ native save          │
│                                   └─ native .key output   │
│                                                           │
│  Render / Fidelity / QA                                   │
│       │                                                   │
│       ├─ source previews                                  │
│       ├─ target previews                                  │
│       ├─ structural comparison                            │
│       └─ visual comparison                                │
│                                                           │
│  Reports / Artifacts                                      │
└───────────────────────────────────────────────────────────┘
```

---

# 6. Core Modules

## 6.1 Job Service

Responsibilities:

- accept one PPTX;
- assign conversion job ID;
- validate file type;
- create isolated job workspace;
- select requested targets:
  - Keynote;
  - Google Slides;
  - both;
- maintain deterministic job state;
- expose conversion status;
- collect artifacts;
- clean temporary data according to retention policy.

Suggested states:

```text
queued
preflight
converting_google
converting_keynote
verifying
completed
completed_with_warnings
failed
cancelled
```

No state may claim success without target-specific success evidence.

---

## 6.2 PPTX Preflight

PPTX is an OPC/ZIP package containing OOXML parts.

The preflight stage should inventory, not mutate, the source.

Initial inventory targets:

```text
ppt/presentation.xml
ppt/slides/
ppt/slideLayouts/
ppt/slideMasters/
ppt/theme/
ppt/media/
ppt/charts/
ppt/embeddings/
ppt/notesSlides/
ppt/comments/
_rels/
docProps/
```

Preflight output:

```text
source-manifest.json
```

Example conceptual fields:

```json
{
  "formatVersion": 1,
  "slideCount": 20,
  "pageSize": {},
  "fonts": [],
  "masters": [],
  "layouts": [],
  "objects": {},
  "media": [],
  "charts": [],
  "tables": [],
  "notes": {},
  "animations": {},
  "transitions": {},
  "relationships": [],
  "warnings": []
}
```

The analyzer must be read-only.

---

# 7. Presentation Intermediate Representation (IR)

The IR is not a substitute presentation format.

It is a normalized evidence and comparison layer.

Proposed hierarchy:

```text
Presentation
├── metadata
├── pageSize
├── theme
├── fonts[]
├── masters[]
├── layouts[]
└── slides[]
    ├── background
    ├── elements[]
    │   ├── text
    │   ├── shape
    │   ├── image
    │   ├── group
    │   ├── table
    │   ├── chart
    │   ├── media
    │   └── unknown
    ├── notes
    ├── transitions
    └── animations
```

Each element should preserve:

- stable source identity where available;
- type;
- x/y;
- width/height;
- rotation;
- z-order;
- visibility;
- transform;
- style;
- relationship targets;
- source XML reference.

## IR rule

Unknown or unsupported source data must remain explicit.

Never silently translate:

```text
unknown → supported
```

The engine should record:

```text
unknown / unsupported / approximated / flattened
```

as factual compatibility evidence.

---

# 8. Google Slides Conversion Path

## Preferred path

```text
PPTX
  ↓
Google Drive upload + native conversion
  ↓
Google Slides presentation
  ↓
Slides API inspection
  ↓
optional bounded repair
  ↓
native Google Slides result
```

## Required conversion behavior

Before conversion:

1. query Drive `about.importFormats`;
2. verify the current environment reports PowerPoint → Google Slides conversion support;
3. upload the PPTX while creating a Google Slides MIME target;
4. record returned Drive file ID;
5. verify resulting MIME type is:

```text
application/vnd.google-apps.presentation
```

6. retrieve presentation metadata through Slides API;
7. compare slide count and selected structural facts against source preflight;
8. generate target report.

## Google native success evidence

Minimum:

- Drive create/import request succeeded;
- target file ID returned;
- MIME type is native Google Slides;
- Slides API `presentations.get` succeeds;
- target slide count is available.

## Google repair engine

Repairs should be post-import and bounded.

Possible future repair categories:

- text overflow;
- font replacement;
- image positioning;
- crop correction;
- background correction;
- object transform correction;
- broken hyperlink repair;
- unsupported object fallback.

Do not rebuild a successfully imported slide wholesale when one bounded object repair is sufficient.

---

# 9. Keynote Conversion Path

## Architecture

```text
PPTX
  ↓
secure conversion job
  ↓
macOS worker
  ↓
Keynote
  ↓
open/import PPTX
  ↓
save native Keynote presentation
  ↓
.key artifact
  ↓
verification
```

## Why macOS worker

Do not reverse-engineer `.key`.

The native Keynote application should remain the authority for PPTX → Keynote document translation.

## Worker requirements

The Keynote worker must eventually provide:

- job pickup;
- local temporary workspace;
- deterministic input/output names;
- Keynote availability check;
- Keynote version capture;
- PPTX open/import;
- native save;
- timeout protection;
- application error capture;
- output existence check;
- output size check;
- optional preview export;
- cleanup;
- structured result JSON.

## Keynote automation feasibility gate

Before building the full worker:

1. identify the exact Keynote version;
2. inspect the installed scripting dictionary / supported automation surface;
3. prove opening a controlled PPTX;
4. prove native save to `.key`;
5. prove deterministic target path;
6. prove process cleanup;
7. prove noninteractive operation where possible;
8. document any macOS Automation / Accessibility permissions required.

Only after these checks pass is the automation implementation chosen.

Preferred order:

```text
1. native Keynote scripting interface
2. AppleScript/JXA wrapper around native scripting
3. bounded System Events/UI automation only if unavoidable
```

UI automation must not be the first choice because it is more fragile.

---

# 10. Local vs Remote Keynote Worker

The architecture must support a worker abstraction from the beginning.

```text
KeynoteWorkerProvider
├── LocalMacWorker
└── RemoteMacWorker
```

V1 does not need both implementations.

The abstraction prevents the core converter from assuming it always runs on macOS.

Possible deployment later:

```text
Windows/Web orchestrator
          │
          ▼
   authenticated job queue
          │
          ▼
       Mac mini
          │
          ▼
        Keynote
```

No remote worker implementation should be added until required.

---

# 11. Fidelity Engine

A completed conversion is not automatically a high-fidelity conversion.

The project should eventually calculate separate fidelity dimensions.

Proposed score families:

```text
Structural Fidelity
Visual Fidelity
Typography Fidelity
Media Fidelity
Animation Fidelity
Notes Fidelity
Overall Confidence
```

Example:

```text
Keynote
Overall          97.8%
Layout           99.4%
Typography       95.6%
Images          100.0%
Charts           98.0%
Animation        83.0%
Notes           100.0%
```

Scores must not pretend to measure properties that have not actually been inspected.

---

# 12. Structural QA

Initial structural checks:

- slide count;
- page dimensions;
- title/text presence;
- object count ranges;
- image count;
- chart count;
- table count;
- notes presence;
- hyperlink presence;
- master/layout inventory;
- target artifact type;
- empty/corrupt slide detection.

Structural QA should produce machine-readable evidence:

```text
structural-report.json
```

---

# 13. Visual QA

## Goal

Detect slides whose visual appearance materially changed.

Pipeline:

```text
Source PPTX
  ↓
source slide render
  ↓
source PNGs

Target
  ↓
target slide render
  ↓
target PNGs

source PNG ↔ target PNG
        ↓
visual comparison
        ↓
per-slide difference score
```

V1 visual comparison does not need an AI model.

Start with deterministic image comparison:

- normalized dimensions;
- perceptual hashes;
- pixel difference / SSIM-style metric;
- optional region heatmaps.

Later versions may add semantic object-aware comparison.

## Important limitation

Visual similarity cannot prove editability or structural preservation.

Therefore:

```text
visual evidence ≠ structural evidence
```

Both are required.

---

# 14. Compatibility Classification

Every source feature should eventually map to one of:

```text
preserved
preserved_with_substitution
approximated
flattened
unsupported
unknown
```

Example:

```text
Font: Gotham
Google Slides → preserved_with_substitution
Keynote       → preserved if font installed, otherwise substitution

PowerPoint Morph
Google Slides → unsupported/approximated
Keynote       → mapping must be empirically tested
```

Do not hardcode assumptions for complex target mappings before test evidence exists.

---

# 15. Font Strategy

Fonts are one of the highest-risk fidelity areas.

Preflight must identify:

- font family;
- font face;
- bold/italic;
- embedded font presence if applicable;
- theme font;
- missing font risk.

Target reports should distinguish:

```text
exact font
available equivalent
substituted
missing
unknown
```

A future optional font map could look like:

```json
{
  "Gotham": {
    "google": "Montserrat",
    "keynote": "Avenir Next"
  }
}
```

Font substitution must never silently occur in the converter's report.

---

# 16. Unsupported Object Strategy

Do not choose one universal fallback.

Use an ordered fallback policy per object class.

Example:

```text
native preservation
        ↓
native approximation
        ↓
editable simplified reconstruction
        ↓
high-resolution flattening
        ↓
explicit unsupported warning
```

Flattening should be a deliberate fallback, not the default.

When flattening occurs, report:

- slide;
- object;
- reason;
- source type;
- target limitation;
- whether editability was lost.

---

# 17. Animation / Transition Strategy

Animations and transitions are not V1 release blockers unless explicitly included in the approved V1 acceptance criteria.

Initial implementation should:

1. inventory them;
2. preserve through target native import when target importer supports them;
3. inspect what can be observed after conversion;
4. classify lost/changed effects;
5. avoid inventing unsupported target equivalents.

Animation conversion will be developed from empirical compatibility matrices, not assumptions.

---

# 18. Charts and Tables

## Charts

Preferred:

```text
native import result
        ↓
inspect
        ↓
keep native if valid
        ↓
repair only when bounded and possible
```

Do not rebuild every PowerPoint chart using Sheets unless a specific repair mode requires it.

## Tables

Tables should remain native/editable where importer supports them.

Report:

- row/column count;
- merges;
- fill/stroke;
- typography;
- geometry;
- lost formatting.

---

# 19. Media

Preflight should classify:

- raster images;
- SVG;
- video;
- audio;
- embedded OLE/Office objects;
- external linked resources.

For each target:

```text
preserved
embedded
linked
flattened
unsupported
```

External links must not be silently downloaded without an explicit future policy.

---

# 20. Security Model

The converter processes arbitrary user PPTX files.

Treat them as untrusted input.

Required controls:

- file size limits;
- ZIP expansion limits;
- path traversal prevention;
- relationship target validation;
- external reference restrictions;
- XML parser hardening;
- temporary workspace isolation;
- no execution of embedded binaries/macros;
- no Office macro execution;
- no automatic opening of extracted executables;
- secret redaction;
- job-specific directories;
- bounded logs;
- target-account access scoped as narrowly as practical.

PPTM/macro-enabled input should not be silently accepted as equivalent to PPTX.

---

# 21. Google Authentication

V1 should use explicit Google OAuth for a real user account.

Do not embed credentials in source.

Separate:

```text
config/
secrets/
runtime/
```

OAuth storage must be its own project state.

Required scopes should be minimized during implementation.

The plan should prefer creating only the files the converter owns rather than requesting broad Drive access if narrower scopes can satisfy the conversion path.

Exact scope selection is an implementation-stage security decision and must be documented before OAuth registration.

---

# 22. Keynote Worker Security

If a remote Mac worker is introduced:

- mutually authenticated transport;
- no arbitrary command endpoint;
- converter-job protocol only;
- unique job IDs;
- signed/authenticated requests;
- bounded input size;
- fixed temp root;
- path traversal protection;
- worker cannot access arbitrary host files through job data;
- result hashes;
- cleanup after retention window.

The worker is a conversion appliance, not a generic remote shell.

---

# 23. Data and Persistence

V1 should avoid adding a database unless persistence requirements justify it.

Preferred early model:

```text
runtime/
└── jobs/
    └── <job-id>/
        ├── source/
        ├── preflight/
        ├── google/
        ├── keynote/
        ├── previews/
        ├── reports/
        └── job.json
```

A SQLite job database may be introduced only when required for:

- resumable queues;
- crash recovery;
- multi-worker scheduling;
- history search;
- retention policy;
- web service operation.

Avoid infrastructure that the V1 CLI/kernel does not need.

---

# 24. Proposed Fresh Repository Structure

**Not to be created before approval.**

```text
Presentation-Bridge/
├── README.md
├── CHANGELOG.md
├── SECURITY.md
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
│
├── docs/
│   ├── architecture.md
│   ├── conversion-contract.md
│   ├── fidelity-model.md
│   ├── google-slides.md
│   ├── keynote-worker.md
│   └── compatibility-matrix.md
│
├── src/
│   ├── cli/
│   ├── config/
│   ├── jobs/
│   ├── pptx/
│   │   ├── opc/
│   │   ├── ooxml/
│   │   ├── preflight/
│   │   └── ir/
│   │
│   ├── converters/
│   │   ├── google/
│   │   └── keynote/
│   │
│   ├── workers/
│   │   └── keynote/
│   │
│   ├── fidelity/
│   │   ├── structural/
│   │   ├── visual/
│   │   └── scoring/
│   │
│   ├── reports/
│   ├── security/
│   └── runtime/
│
├── tests/
│   ├── fixtures/
│   ├── unit/
│   ├── integration/
│   ├── compatibility/
│   └── acceptance/
│
├── corpus/
│   └── README.md
│
└── runtime/
    └── .gitkeep
```

---

# 25. Suggested Technology Baseline

## Core

```text
Node.js + TypeScript
```

Reasons:

- strong ZIP/XML ecosystem;
- Google APIs well supported;
- straightforward CLI/server evolution;
- shared schemas across orchestrator and worker protocol;
- easy structured JSON evidence.

## PPTX parsing

Prefer direct OOXML/OPC parsing with narrowly selected libraries for:

- ZIP container;
- XML parsing;
- schema utilities.

Do not use a library as unquestioned truth if it hides source relationships needed by fidelity analysis.

## Google

- Google Drive API;
- Google Slides API.

## Keynote

- macOS;
- installed Keynote;
- native scripting/automation surface after feasibility proof.

## Image QA

Start deterministic.

Possible implementation libraries are an implementation-stage choice after review and license checks.

---

# 26. Test Corpus

Before attempting broad compatibility, create a controlled PPTX corpus.

Minimum corpus:

```text
01-basic-text-shapes.pptx
02-images-and-crop.pptx
03-master-layout-theme.pptx
04-tables.pptx
05-charts.pptx
06-svg.pptx
07-gradients-transparency.pptx
08-groups-rotation.pptx
09-links-notes.pptx
10-animation-transition.pptx
11-media.pptx
12-complex-real-world.pptx
```

Each fixture must have:

- source description;
- expected feature inventory;
- source slide previews;
- target-specific known limitations once discovered.

The corpus becomes the compatibility benchmark.

---

# 27. Milestone Plan

## Phase 0 — Repository Bootstrap

**Blocked until plan approval.**

Deliverables:

- fresh standalone repository;
- base docs;
- project isolation checks;
- TypeScript build;
- basic CLI skeleton;
- runtime folder contract;
- security baseline.

Acceptance:

- no imports/dependencies from another project;
- repository builds independently;
- project purpose documented.

---

## Phase 1 — PPTX Preflight Kernel

Deliverables:

- safe OPC/ZIP reader;
- package inventory;
- presentation metadata;
- slide count/dimensions;
- media inventory;
- basic text/shape/image inventory;
- masters/layout/theme inventory;
- source manifest;
- corruption/safety errors.

Acceptance:

- controlled fixtures produce deterministic manifests;
- no source mutation;
- malicious ZIP/path cases rejected.

---

## Phase 2 — Google Native Conversion

Deliverables:

- Google OAuth;
- Drive import availability check;
- PPTX upload + Google Slides conversion;
- native MIME verification;
- Slides API inspection;
- structured result.

Acceptance:

```text
PPTX → native Google Slides file ID
```

with:

- target MIME verified;
- presentation retrievable by Slides API;
- source/target slide count compared;
- failures classified.

---

## Phase 3 — Keynote Feasibility Proof

Deliverables:

- macOS worker prototype specification;
- installed Keynote version capture;
- scripting dictionary/automation probe;
- controlled PPTX open;
- native `.key` save;
- deterministic output path;
- structured worker result;
- cleanup proof.

Acceptance:

```text
controlled PPTX → valid native .key
```

without manual interaction for the supported runtime path.

If this gate fails, stop and redesign the Keynote adapter before proceeding.

---

## Phase 4 — Keynote Production Worker

Deliverables:

- worker lifecycle;
- job protocol;
- timeouts;
- crash cleanup;
- output verification;
- logs;
- retries for safe failure classes;
- local worker implementation.

Acceptance:

- repeated conversions do not leave Keynote/process/temp-state leakage;
- result artifacts deterministic and attributable to job ID.

---

## Phase 5 — Structural Fidelity

Deliverables:

- source/target comparison schema;
- per-target compatibility classification;
- slide count and feature checks;
- warnings;
- conversion report.

Acceptance:

Each conversion provides machine-readable evidence explaining:

```text
what was preserved
what changed
what could not be verified
```

---

## Phase 6 — Visual Fidelity

Deliverables:

- source slide renderer strategy;
- target preview renderer strategy;
- image normalization;
- per-slide difference scoring;
- visual heatmaps for failures;
- threshold configuration.

Acceptance:

- known modified fixture is detected;
- known identical/near-identical fixture does not produce excessive false alarms.

---

## Phase 7 — Bounded Repair

Only after fidelity evidence exists.

Candidate repair classes:

- text overflow;
- missing/substituted font warnings;
- image crop/placement;
- background;
- basic transforms;
- hyperlinks.

Acceptance:

- repairs are object-local where possible;
- no entire-slide reconstruction unless explicitly required;
- before/after evidence retained.

---

## Phase 8 — Product Interface

Only after the conversion kernel is stable.

Possible interfaces:

- CLI;
- desktop app;
- web UI;
- batch folder mode.

Initial CLI contract candidate:

```text
presentation-bridge convert input.pptx --target google
presentation-bridge convert input.pptx --target keynote
presentation-bridge convert input.pptx --target all
```

UI must not become a blocker for conversion correctness.

---

# 28. V1 Scope Recommendation

## V1 Must Have

- fresh isolated project;
- PPTX validation;
- safe preflight;
- native Google Slides conversion;
- native Keynote conversion;
- slide count verification;
- source/target manifests;
- font inventory;
- media inventory;
- structural compatibility warnings;
- deterministic job artifacts;
- conversion report;
- controlled test corpus;
- no silent success.

## V1 Should Have

- source slide previews;
- target previews;
- basic visual comparison;
- speaker note check;
- hyperlink check;
- tables/charts inventory.

## V1 May Have

- automated bounded repairs;
- batch conversion;
- local web UI.

## Explicitly Not Required for First Stable V1

- perfect preservation of every PowerPoint animation;
- PowerPoint VBA/macros;
- arbitrary OLE reconstruction;
- reverse-engineered `.key` writer;
- collaborative editing platform;
- cloud multi-tenancy;
- generic remote-control agent;
- AI-based visual analysis;
- database cluster;
- Kubernetes;
- microservices for their own sake.

---

# 29. Error Taxonomy

Use structured failures.

Examples:

```text
SOURCE_INVALID_PPTX
SOURCE_ZIP_BOMB_RISK
SOURCE_UNSUPPORTED_ENCRYPTION
GOOGLE_AUTH_REQUIRED
GOOGLE_IMPORT_UNAVAILABLE
GOOGLE_UPLOAD_FAILED
GOOGLE_TARGET_NOT_NATIVE
GOOGLE_SLIDES_GET_FAILED
KEYNOTE_WORKER_UNAVAILABLE
KEYNOTE_NOT_INSTALLED
KEYNOTE_AUTOMATION_PERMISSION_DENIED
KEYNOTE_OPEN_FAILED
KEYNOTE_SAVE_FAILED
KEYNOTE_OUTPUT_MISSING
FIDELITY_RENDER_FAILED
FIDELITY_TARGET_UNVERIFIABLE
JOB_TIMEOUT
```

Errors should contain safe diagnostics without secrets.

---

# 30. Conversion Result Contract

Conceptual result:

```json
{
  "jobId": "...",
  "status": "completed_with_warnings",
  "source": {
    "filename": "deck.pptx",
    "sha256": "...",
    "slideCount": 20
  },
  "targets": {
    "googleSlides": {
      "status": "completed",
      "native": true,
      "fileId": "...",
      "slideCount": 20
    },
    "keynote": {
      "status": "completed",
      "native": true,
      "artifact": "deck.key",
      "slideCount": 20
    }
  },
  "fidelity": {},
  "warnings": [],
  "artifacts": []
}
```

Never include OAuth tokens or secrets in this structure.

---

# 31. Artifact Contract

Per job:

```text
<job-id>/
├── source/
│   └── original.pptx
├── preflight/
│   ├── source-manifest.json
│   └── compatibility-preflight.json
├── google/
│   ├── result.json
│   └── preview/
├── keynote/
│   ├── result.json
│   ├── output.key
│   └── preview/
├── fidelity/
│   ├── structural-report.json
│   ├── visual-report.json
│   └── heatmaps/
└── conversion-report.json
```

A Google Slides cloud document is referenced by file ID/URL rather than copied as a fake local Google file.

---

# 32. Logging Rules

Logs should be:

- structured;
- bounded;
- job-scoped;
- timestamped;
- redacted.

Do not log:

- OAuth access token;
- refresh token;
- Google client secret;
- Keynote worker secret;
- entire PPTX XML by default;
- user media binary data.

---

# 33. Determinism and Evidence Rules

Evidence precedence:

```text
native target existence
>
target platform API/application verification
>
structural comparison
>
visual comparison
>
heuristic compatibility prediction
```

Do not reverse this precedence.

Examples:

- visual similarity cannot prove the target is native;
- filename `.key` alone cannot prove a valid Keynote document;
- upload success alone cannot prove Google conversion completed;
- slide count equality cannot prove layout fidelity.

---

# 34. Performance Targets — Initial

Do not over-optimize before profiling.

Initial non-binding goals:

- preflight should stream/parse rather than load unbounded expanded content;
- Google upload uses resumable upload for sufficiently large files;
- visual rendering is parallelized only within safe resource bounds;
- one failed target does not corrupt the other target's result;
- job cancellation releases temporary resources.

Performance thresholds should be benchmarked from the test corpus before becoming release gates.

---

# 35. Compatibility Matrix

Maintain:

```text
docs/compatibility-matrix.md
```

Example columns:

| Feature | PPTX | Google Slides | Keynote | Evidence | Status |
|---|---|---|---|---|---|
| Text | source | test | test | fixture | TBD |
| Crop | source | test | test | fixture | TBD |
| SVG | source | test | test | fixture | TBD |
| Charts | source | test | test | fixture | TBD |
| Morph | source | test | test | fixture | TBD |

No compatibility claim becomes “supported” without a reproducible fixture/test.

---

# 36. Release Definition

A V1 release is not “stable” until:

1. project is independently buildable;
2. PPTX preflight security tests pass;
3. Google native conversion passes corpus acceptance;
4. Keynote native conversion passes corpus acceptance;
5. error states do not claim success;
6. conversion report exists;
7. no secrets are in repo/artifacts/logs;
8. conversion results are repeatable;
9. known limitations are documented;
10. fresh-machine setup is documented.

---

# 37. Key Risks

## Risk A — Keynote automation fragility

Mitigation:

- feasibility gate first;
- prefer native scripting over UI automation;
- pin/test supported Keynote/macOS versions;
- worker health check.

## Risk B — Target importer behavior changes

Mitigation:

- query dynamic Google import capabilities;
- compatibility corpus;
- target-version metadata;
- regression fixtures.

## Risk C — Fonts

Mitigation:

- explicit inventory/substitution evidence;
- optional font mapping;
- target worker font availability report.

## Risk D — Animations

Mitigation:

- inventory first;
- empirical compatibility mapping;
- do not overpromise V1.

## Risk E — Fake fidelity confidence

Mitigation:

- separate structural/visual/native evidence;
- unknown remains unknown;
- never derive unsupported certainty from a single score.

## Risk F — Malicious PPTX

Mitigation:

- hardened ZIP/XML processing;
- no embedded code execution;
- bounded extraction.

---

# 38. Decisions Required During User Review

The following are intentionally **not implemented yet** and should be confirmed before integration:

### A. Project name
Proposed:

```text
Presentation-Bridge
```

### B. Initial host
Recommended:

```text
Core/orchestrator: Windows-friendly Node.js/TypeScript
Keynote worker: macOS + Keynote
```

### C. V1 interface
Recommended:

```text
CLI/kernel first
UI after converter stability
```

### D. Google result ownership
Recommended:

```text
Converted Google Slides remains in the authenticated user's Drive.
```

### E. Keynote worker topology
Recommended V1:

```text
Local or directly reachable single macOS worker.
```

Do not build distributed worker infrastructure prematurely.

### F. Fidelity level
Recommended:

```text
Structural report in V1 mandatory.
Visual diff introduced during V1 stabilization, before polished UI.
```

### G. Repair policy
Recommended:

```text
No automatic aggressive reconstruction in first conversion path.
Import natively → inspect → repair only bounded defects.
```

---

# 39. Proposed Implementation Order

```text
1. Fresh Repository + Isolation
        ↓
2. Secure PPTX Preflight
        ↓
3. Google Native Import
        ↓
4. Keynote Automation Feasibility Gate
        ↓
5. Keynote Worker
        ↓
6. Structural Fidelity
        ↓
7. Visual Fidelity
        ↓
8. Bounded Repair
        ↓
9. Batch / UI
```

The ordering is deliberate:

- prove target-native conversion before building UI;
- prove Keynote automation before investing in its worker;
- collect evidence before attempting repair;
- repair only defects demonstrated by evidence.

---

# 40. Approval Gate

## Current state

```text
PLAN CREATED
IMPLEMENTATION NOT STARTED
INTEGRATION NOT STARTED
NO PROJECT DIRECTORY CREATED
NO DEPENDENCIES INSTALLED
NO CREDENTIALS CREATED
```

## Next action after review

Only after explicit approval:

```text
Phase 0 — create fresh standalone project
```

Then implementation proceeds milestone-by-milestone, with each milestone retaining its own documentation and acceptance evidence.

---

# 41. Official References Used for Architecture Validation

Google Drive API — Upload file data / Import to Google Workspace types
https://developers.google.com/workspace/drive/api/guides/manage-uploads

Google Slides API — Presentation operations / batchUpdate
https://developers.google.com/workspace/slides/api/

Apple Keynote User Guide — Save and name a Keynote presentation on Mac
https://support.apple.com/guide/keynote/save-and-name-a-presentation-tanf51f6f6d9/mac

Apple Keynote User Guide for Mac
https://support.apple.com/guide/keynote/welcome-tand2703708a/mac

---

# 42. Final Planning Principle

The converter should evolve from:

```text
"the file opened"
```

to:

```text
"the target is native,
the important structure was verified,
the visual result was measured,
and every known loss is reported."
```

That is the product boundary this plan is designed to preserve.
