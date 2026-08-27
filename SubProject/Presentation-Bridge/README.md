# Presentation Bridge

Fresh, standalone conversion kernel for **PPTX → native Google Slides** and **PPTX → native Keynote (.key)** with explicit structural/visual evidence.

## Product boundary

Presentation Bridge never equates “the file opened” with “conversion succeeded”. A native conversion succeeds only when the target platform itself has produced and verified its native target:

- Google: Drive returns `application/vnd.google-apps.presentation` and Slides `presentations.get` succeeds.
- Keynote: a real macOS Keynote process saves a `.key` artifact and the worker verifies the output exists.

Mock mode is only a deterministic contract test. **Mock mode can never set `native: true` and never creates a fake `.key`.**

## Isolation

This repository is intentionally standalone. It has no imports, runtime paths, secrets, databases, launchers, or source dependencies from any other user project.

## Requirements

- Node.js 20.12+
- npm
- For Google live conversion: a Google Cloud OAuth **Desktop app** client with Drive API + Slides API enabled.
- For Keynote live conversion: macOS with Keynote installed and Automation permission for the invoking terminal/runtime.
- Optional local source rendering: LibreOffice (`soffice`) + `pdftoppm`.

## Install

```bash
npm install
npm run build
npm test
node dist/src/cli/index.js doctor
```

On a Windows production machine, put the repository in its own directory, for example:

```text
E:\Presentation-Bridge
```

Do not place it inside another project's repository or runtime directory.

## CLI

```text
presentation-bridge preflight deck.pptx --output manifest.json --ir ir.json
presentation-bridge convert deck.pptx --target google
presentation-bridge convert deck.pptx --target keynote
presentation-bridge convert deck.pptx --target all
presentation-bridge google auth
presentation-bridge google doctor
presentation-bridge keynote doctor
presentation-bridge fidelity visual source.png target.png --diff diff.png
presentation-bridge doctor
```

During development from the repo:

```bash
node dist/src/cli/index.js ...
```

### Explicit test-only mocks

```bash
node dist/src/cli/index.js convert corpus/generated/12-complex-real-world.pptx \
  --target all --mock-google --mock-keynote
```

This validates the orchestration/report contract only. It does not count as target-native acceptance.

## Job artifacts

```text
runtime/jobs/<job-id>/
├── source/
├── preflight/
│   ├── source-manifest.json
│   ├── presentation-ir.json
│   └── compatibility-preflight.json
├── google/
│   └── result.json
├── keynote/
│   └── result.json
├── fidelity/
│   ├── source-preview/
│   ├── structural-google.json
│   ├── structural-keynote.json
│   ├── visual-google.json       # live Google when preview evidence is available
│   ├── visual-keynote.json      # live Keynote when preview evidence is available
│   ├── visual-google/           # per-slide diff images
│   └── visual-keynote/          # per-slide diff images
├── job.json
├── conversion-report.json
└── compatibility-report.html
```

A successful live Keynote job additionally contains the `.key` artifact. For live Keynote conversion, the worker requests a PDF preview by default so visual evidence can be generated when `pdftoppm` is available. A Google result stores the native Drive file ID/URL and retrieves target thumbnails for visual evidence; it never fabricates a local “Google Slides file”.

## Evidence hierarchy

```text
native target existence / platform verification
    > structural comparison
    > visual comparison
    > heuristic compatibility prediction
```

Unknown remains unknown. Visual similarity cannot prove editability.

## Controlled corpus

`npm test` regenerates twelve controlled PPTX fixtures under `corpus/generated/` and then runs local unit/integration/acceptance tests.

## Live acceptance

See:

- `docs/google-slides.md`
- `docs/keynote-worker.md`
- `docs/INTEGRATION_STATUS.md`

Live Google acceptance requires user OAuth; live Keynote acceptance requires a macOS+Keynote runtime. The code does not fake these gates when the environment is unavailable.

## Dependency reproducibility note

The release manifest pins the exact dependency versions used by local verification. This build environment could not reach the public npm registry, so a registry-generated `package-lock.json` is intentionally not fabricated. On the target machine, run `npm install`; npm will resolve the pinned versions and create the local lockfile.
