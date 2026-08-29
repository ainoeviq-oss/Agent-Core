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
npm ci
npm run build
npm test
node dist/src/cli/index.js doctor
```

`package-lock.json` is committed and is the reproducible install contract for the verified release.

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
presentation-bridge host --host 127.0.0.1 --port 4173
presentation-bridge google auth
presentation-bridge google doctor
presentation-bridge keynote doctor
presentation-bridge keynote worker --host 127.0.0.1 --port 4815
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

## Desktop and hosted surfaces

Version 0.2.0 includes an Electron desktop application and a hosted browser surface backed by the same conversion service. The desktop build uses context isolation and a preload API; selected input/output paths are bounded by the native pickers. Hosted mode binds to loopback by default and requires `PB_HOSTED_TOKEN` when exposed beyond loopback.

Remote Keynote conversion uses the bounded worker protocol documented in `docs/keynote-worker.md`. Non-loopback workers require TLS plus bearer authentication. Desktop worker tokens are encrypted with Electron `safeStorage` before they are persisted.

## Dependency reproducibility and audit

`package-lock.json` is committed. Use `npm ci` for reproducible installs. The packaged/runtime dependency audit (`npm audit --omit=dev`) is expected to contain no high or critical findings. The development-only fixture generator currently retains `pptxgenjs` because npm's audit-recommended downgrade is incompatible with the controlled corpus generator; see `SECURITY.md` for the scoped development-tooling note.
