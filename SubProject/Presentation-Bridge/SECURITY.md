# Security

Presentation files are untrusted input.

## PPTX package controls

The preflight kernel parses the ZIP central directory before any entry is decompressed and enforces:

- source byte limit;
- expanded byte limit;
- per-entry expanded byte limit;
- ZIP-entry count limit;
- rejection of absolute paths and `..` traversal;
- rejection of encrypted ZIP entries;
- supported compression methods only (stored/deflate);
- output-length verification;
- CRC-32 verification when an entry is read.

The converter never executes binaries or macros embedded in a presentation. `.pptm` is not silently treated as `.pptx`.

## External relationships

OOXML external relationships are inventoried but are **not automatically downloaded**.

## Google OAuth

The project requests only:

```text
https://www.googleapis.com/auth/drive.file
```

The desktop authorization flow uses PKCE and a random loopback listener on `127.0.0.1`. Access/refresh tokens are stored only under the project-owned `secrets/google/` path and are ignored by Git.

Never commit:

- OAuth client secrets;
- access tokens;
- refresh tokens;
- conversion inputs containing private information.

## Keynote worker

The local worker is not a generic remote shell. It invokes only packaged AppleScript conversion/export scripts with job-controlled input/output paths.

The remote worker exposes only the bounded Presentation Bridge worker protocol. It requires bearer authentication, refuses non-loopback cleartext binding, requires TLS for non-loopback service, limits PPTX upload size, validates native `.key` artifacts before delivery, and never returns stored worker credentials in metadata. Desktop remote-worker tokens are persisted through Electron `safeStorage`, not plaintext settings.

## Dependency audit

The distributable runtime is checked with `npm audit --omit=dev`. Version 0.2.0 pins `sharp` to a patched 0.35.x release so the runtime audit has no high or critical findings.

The full development audit can still report the `pptxgenjs` test-fixture tool through its `image-size` dependency. The registry currently offers no `image-size` release outside the advisory range, and npm's suggested `pptxgenjs@1.1.5` downgrade is incompatible with the controlled fixture generator. `pptxgenjs` remains a development-only dependency used to create local test corpus files and is not included in the packaged application runtime.

## Windows release trust

The verified cross-built v0.2.0 artifacts are unsigned unless an Authenticode identity is explicitly supplied. `npm run verify:release` records checksums and package boundaries but does not represent code signing or native Windows certification. Public distribution should add a trusted certificate and complete Windows 10/11 host smoke testing.

The release verifier rejects packaged source tests, source trees, project secrets, and runtime state. Google Desktop OAuth configuration is omitted unless both build-time provisioning variables are explicitly provided.

## Logging

Conversion result structures never intentionally include Google tokens or project secrets. API error bodies are bounded before being reported.
