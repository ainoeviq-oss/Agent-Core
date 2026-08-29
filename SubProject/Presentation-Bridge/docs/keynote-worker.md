# Keynote Worker

## Boundary

Presentation Bridge does not reverse-engineer `.key`. A real Keynote installation remains the authority for PPTX → Keynote translation.

## Local macOS worker

```text
macOS
  ├─ /Applications/Keynote.app
  ├─ /usr/bin/osascript
  └─ Presentation Bridge
       ├─ query Keynote version
       ├─ inspect scripting definition when `sdef` exists
       ├─ open source PPTX
       ├─ save native .key
       ├─ count target slides
       └─ optionally export a PDF preview
```

Feasibility gate on the target Mac:

```bash
npm ci
npm run build
node dist/src/cli/index.js keynote doctor
```

Native acceptance:

```bash
node dist/src/cli/index.js convert corpus/generated/12-complex-real-world.pptx \
  --target keynote --keynote-pdf-preview --output runtime/acceptance/keynote
```

macOS may prompt for Automation permission when the terminal/runtime first controls Keynote.

## Authenticated remote worker

Version 0.2.0 implements a bounded converter-only HTTP(S) worker. It is not a generic command interface.

Start a loopback worker on a Mac:

```bash
export PB_KEYNOTE_WORKER_TOKEN='replace-with-a-random-token'
node dist/src/cli/index.js keynote worker --host 127.0.0.1 --port 4815
```

For non-loopback binding, configure TLS as a pair:

```text
PB_KEYNOTE_WORKER_TLS_CERT
PB_KEYNOTE_WORKER_TLS_KEY
```

Optional worker settings:

```text
PB_KEYNOTE_WORKER_HOST
PB_KEYNOTE_WORKER_PORT
PB_KEYNOTE_WORKER_ARTIFACT_ROOT
PB_KEYNOTE_WORKER_PUBLIC_URL
```

Configure a client/desktop runtime:

```text
PB_KEYNOTE_WORKER=remote
PB_KEYNOTE_WORKER_URL=https://mac-worker.example.com
PB_KEYNOTE_WORKER_TOKEN=<same bearer token>
```

Plain HTTP is rejected outside loopback. Loopback HTTP is allowed only when explicitly configured for the local trust boundary. The worker limits upload size, verifies the native `.key` artifact before delivery, and never exposes its token in metadata.

The Electron Setup dialog can store remote worker settings. Tokens are encrypted with Electron `safeStorage` before persistence and are reapplied only when no conversion job is active.

## Success evidence

A remote response is not native success by itself. Acceptance requires:

- authenticated worker response;
- real macOS Keynote execution;
- verified `.key` artifact;
- bounded artifact download;
- `verification: "live"` evidence attributable to the job.

## Official reference

Apple documents that Keynote on Mac can open/edit Microsoft PowerPoint `.pptx`/`.ppt` and save the document as Keynote or PowerPoint:

https://support.apple.com/en-gb/guide/keynote/tan72232b56/mac
