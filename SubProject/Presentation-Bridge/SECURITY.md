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

The V1 local worker is not a generic remote shell. It invokes only packaged AppleScript conversion/export scripts with job-controlled input/output paths.

A future remote worker must add authenticated job transport before it can be enabled.

## Logging

Conversion result structures never intentionally include Google tokens or project secrets. API error bodies are bounded before being reported.
