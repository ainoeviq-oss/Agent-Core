# Windows Release — Presentation Bridge v0.2.0

## Outputs

`npm run package:win` builds two distinct unsigned Windows x64 artifacts:

```text
release/Presentation-Bridge-Setup-0.2.0-x64.exe
release/Presentation-Bridge-Portable-0.2.0-x64.exe
```

The same command runs `npm run verify:release` and writes:

```text
release/release-manifest.json
```

The manifest contains byte sizes and SHA-256 hashes for the installer, portable executable, unpacked Electron executable, and `app.asar`.

## Build command

```bash
npm ci
npm run verify
npm run package:win
```

The packaging command is intentionally offline from a publishing perspective:

```text
electron-builder --win nsis portable --publish never
```

It does not upload artifacts or infer a release channel.

## Cross-building from Linux

Electron Builder can assemble the Windows payload from Linux. Final NSIS/portable construction requires:

- Wine 64-bit;
- Wine 32-bit/i386 support because the NSIS bootstrap is PE32;
- an X virtual display such as `xvfb-run` in headless environments.

Example:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false xvfb-run -a npm run package:win
```

A native Windows builder does not require Wine.

## Release verifier contract

`npm run verify:release` fails closed unless all of these are true:

- installer and portable filenames are distinct;
- each expected executable and `app.asar` exists and exceeds a minimum size;
- every artifact receives a SHA-256 digest;
- `app.asar` contains the desktop main process, preload, UI entry point, CLI, and package manifest;
- packaged content excludes tests, TypeScript source, secrets, runtime state, and generated scripts;
- the old colliding generic filename is absent.

For fixture-level tests only, minimum byte thresholds can be overridden with:

```text
PB_RELEASE_MIN_EXE_BYTES
PB_RELEASE_MIN_ASAR_BYTES
```

## Google OAuth provisioning

Google OAuth credentials are omitted by default. A controlled build may provision a Desktop OAuth client through:

```text
PB_GOOGLE_CLIENT_ID
PB_GOOGLE_CLIENT_SECRET
```

Both values must be supplied together. Source credential JSON is never copied from another project.

## Trust and acceptance status

The current cross-built executables are **unsigned**. Windows SmartScreen may warn until an Authenticode certificate is applied. The package also currently uses Electron's default icon because no approved branded `.ico` asset has been supplied.

Cross-build success and ASAR verification prove package integrity, not native Windows behavior. Before public release, run both artifacts on Windows 10/11 x64 and record the desktop smoke result. The release manifest therefore keeps:

```json
{
  "windowsHostSmokePending": true,
  "googleLivePending": true,
  "keynoteLivePending": true
}
```
