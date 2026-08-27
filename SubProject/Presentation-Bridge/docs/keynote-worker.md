# Keynote Worker

## Boundary

Presentation Bridge does not reverse-engineer `.key`. A real Keynote installation remains the authority for PPTX → Keynote translation.

## V1 local worker

```text
macOS
  ├─ /Applications/Keynote.app
  ├─ /usr/bin/osascript
  └─ project worker
       ├─ query Keynote version
       ├─ inspect scripting definition when `sdef` exists
       ├─ open source PPTX
       ├─ save native .key
       ├─ count target slides
       └─ optional export PDF preview
```

## Feasibility gate

Run on the target Mac:

```bash
npm install
npm run build
node dist/src/cli/index.js keynote doctor
```

Then native acceptance:

```bash
node dist/src/cli/index.js convert corpus/generated/12-complex-real-world.pptx \
  --target keynote --keynote-pdf-preview --output runtime/acceptance/keynote
```

macOS may prompt for Automation permission the first time the terminal/runtime controls Keynote.

## Remote worker

The code contains only the V1 provider boundary for a future remote Mac worker. It intentionally returns `unavailable` until an authenticated converter-only protocol is configured. It does not expose a generic remote command interface.

## Official reference

Apple documents that Keynote on Mac can open/edit Microsoft PowerPoint `.pptx`/`.ppt` and save the document as Keynote or PowerPoint:

https://support.apple.com/en-gb/guide/keynote/tan72232b56/mac
