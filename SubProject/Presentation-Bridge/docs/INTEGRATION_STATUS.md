# Integration Status — Presentation Bridge v0.2.0

**Updated:** 2026-08-30
**Repository state:** v0.2 desktop, hosted, conversion kernel, and simple UI are integrated.
**Release state:** Windows x64 release-candidate artifacts can be built and structurally verified; platform-owned live gates remain explicit.

## Integrated product capabilities

- [x] Fresh standalone source tree and project-owned dependency/runtime boundaries
- [x] TypeScript/Node build with committed `package-lock.json`
- [x] Secure ZIP/OPC/OOXML PPTX preflight and deterministic Presentation IR
- [x] Native Google Drive import adapter, native MIME verification, Slides inspection, thumbnails, token refresh, and bounded repairs
- [x] Local macOS Keynote worker contract and AppleScript PPTX → `.key` path
- [x] Authenticated remote Keynote worker/client protocol with TLS enforcement outside loopback
- [x] Structural fidelity evidence and deterministic visual diff/heatmaps
- [x] Job orchestration, progress, cancellation, history, JSON report, and HTML compatibility report
- [x] One-screen React/Vite interface shared by Electron and hosted mode
- [x] Electron context isolation, bounded file/folder pickers, encrypted worker settings, and Linux Electron smoke test
- [x] Hosted HTTP/SSE transport with loopback default and token requirement outside loopback
- [x] Twelve controlled PPTX fixtures and local unit/integration/acceptance coverage
- [x] Windows x64 NSIS installer and portable executable build contracts
- [x] Offline packaging (`--publish never`) with distinct installer/portable artifact names
- [x] Release verifier for SHA-256, minimum size, ASAR required paths, and forbidden source/test/secret/runtime paths
- [x] Runtime dependency audit with zero vulnerabilities
- [x] No hosted CI configuration by design

## Fresh verification evidence

The release-hardening worktree was installed from the committed lockfile and verified on 2026-08-30:

```text
npm ci                         PASS
npm run verify                 PASS — 45/45 tests
npm run smoke:desktop          PASS on Linux/Electron
npm audit --omit=dev           PASS — 0 vulnerabilities
npm run package:win            PASS
npm run verify:release         PASS
```

Generated Windows x64 artifacts:

```text
Presentation-Bridge-Setup-0.2.0-x64.exe
Presentation-Bridge-Portable-0.2.0-x64.exe
release-manifest.json
```

The manifest records exact byte sizes and SHA-256 hashes and confirms that the packaged ASAR contains the required desktop/UI/CLI entries while excluding source tests, secrets, runtime state, and generated test assets.

## External acceptance gates

These are environment-owned acceptance tests, not converter code silently treated as complete.

### Windows host smoke and signing

The Windows executables are successfully cross-built and structurally verified from Linux. They are currently unsigned, use the default Electron icon, and have not yet been launched on a native Windows 10/11 host. A Wine 5 probe is not accepted as Windows certification because Electron 44 terminated inside that compatibility layer.

Required final Windows evidence:

- launch installer on Windows 10/11 x64;
- launch portable executable;
- exercise the built-in `PB_ELECTRON_SMOKE`/IPC path or equivalent desktop smoke;
- confirm file picker, Setup, Recent jobs, and conversion result surfaces;
- optionally apply an Authenticode certificate and branded icon before public distribution.

### Google

Requires a user-owned Google Cloud Desktop OAuth client and interactive account consent. Until supplied and authorized, live Google-native conversion cannot be certified from this environment.

### Keynote

Requires a macOS machine with Keynote installed and Automation permission. The remote worker protocol is implemented, but native `.key` acceptance still requires the real platform.

The CLI `doctor` and release manifest expose these gates explicitly and never turn an unavailable platform into success.

## Dependency audit interpretation

- Distributable runtime: **0 vulnerabilities** with `npm audit --omit=dev`.
- Full development tree: **2 high advisories**, both confined to the `pptxgenjs` fixture-generation chain through `image-size`.
- `pptxgenjs` is development-only and is not included in the packaged application runtime.
