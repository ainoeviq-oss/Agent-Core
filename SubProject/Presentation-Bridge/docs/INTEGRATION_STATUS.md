# Integration Status

Generated/updated during implementation on 2026-08-27.

## Implemented locally

- [x] Fresh standalone source tree
- [x] TypeScript/Node build
- [x] Secure self-contained ZIP/OOXML PPTX preflight
- [x] Source manifest
- [x] Presentation IR
- [x] Google Desktop OAuth (PKCE + loopback)
- [x] Google `about.importFormats` capability verification
- [x] Google resumable PPTX native-import request
- [x] Native MIME verification
- [x] Slides presentation retrieval and structural summary
- [x] Google thumbnail retrieval API
- [x] Bounded Google repair allowlist
- [x] Keynote local macOS worker contract
- [x] Keynote version/scripting feasibility doctor
- [x] Keynote PPTX open → native save AppleScript
- [x] Optional Keynote PDF preview script
- [x] Structural fidelity report
- [x] Deterministic image visual diff + heatmap
- [x] Optional LibreOffice source-renderer adapter
- [x] Live Google thumbnail → source preview visual-fidelity pipeline
- [x] Live Keynote PDF preview → raster → source preview visual-fidelity pipeline
- [x] JSON conversion report
- [x] HTML compatibility report
- [x] Job-state ledger and deterministic artifacts
- [x] 12-fixture controlled corpus
- [x] Local unit/integration/acceptance test suite
- [x] Documentation and approved plan record
- [x] No hosted CI configuration

## External live acceptance gates

These are environmental acceptance tests, not missing converter code.

### Google

Requires a user-owned Google Cloud Desktop OAuth client and interactive consent. Until supplied/authorized, live Google-native conversion cannot be truthfully certified from this environment.

### Keynote

Requires a macOS machine with Keynote installed. The current implementation environment is not macOS, therefore `.key` native output cannot be truthfully certified here.

The CLI `doctor` command exposes both gates explicitly and never turns either unavailable gate into success.

## Dependency installation evidence

The execution environment had no route to the public npm registry, so registry-based `npm install` / lockfile generation could not be performed. The local build/test used preinstalled copies of the exact versions pinned in `package.json`; `node_modules` is excluded from the release artifact. A real target installation must run `npm install` before `npm run verify`.
