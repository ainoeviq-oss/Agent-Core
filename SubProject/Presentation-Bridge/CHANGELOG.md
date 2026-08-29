# Changelog

## 0.2.0 — 2026-08-29

- Added a shared application service with live progress events, cancellation, job snapshots, and persisted conversion history.
- Added a production React/Vite interface shared by Electron desktop and authenticated hosted-browser transports.
- Added Electron desktop packaging, preload IPC isolation, file/folder picker boundaries, compatibility-report opening, and smoke verification.
- Added encrypted desktop Keynote-worker settings using Electron `safeStorage`, with runtime config reapplication and active-job protection.
- Added hosted HTTP/SSE transport with bounded PPTX uploads, loopback-by-default binding, and token requirement for non-loopback service.
- Added authenticated remote Keynote worker/client support, HTTPS enforcement outside loopback, bounded artifact delivery, and native `.key` verification.
- Added build-time Google Desktop OAuth distribution provisioning without committing client credentials.
- Added packaged-source isolation coverage and Electron/package-directory acceptance gates.
- Upgraded `sharp` to 0.35.4; distributable runtime audit has no high or critical findings.
- Live Google acceptance still requires user OAuth; live Keynote acceptance still requires a real macOS + Keynote worker. These gates remain explicit rather than simulated.
- Hardened Windows release packaging with distinct NSIS/portable filenames, offline publish mode, canonical package metadata, SHA-256 manifest generation, and ASAR boundary verification.
- Added release regression coverage and documented unsigned/native-Windows acceptance boundaries.

## 0.1.0 — 2026-08-27

- Fresh standalone repository initialized.
- Self-contained secure PPTX ZIP/OOXML preflight kernel.
- Presentation manifest + normalized IR.
- Native Google Slides REST adapter with Drive import capability check, resumable upload, native MIME verification, Slides retrieval, PKCE desktop OAuth, token refresh, thumbnails, and bounded repairs.
- Native Keynote local macOS worker contract with Keynote/scripting feasibility doctor, PPTX open/save automation, optional PDF preview, and honest unavailable behavior on non-macOS systems.
- Structural fidelity engine.
- Deterministic raster visual-diff engine.
- Job orchestration, JSON evidence, and HTML compatibility report.
- 12-file controlled PPTX corpus generator.
- Local unit/integration/acceptance test suite.
- No hosted CI configuration by design.
