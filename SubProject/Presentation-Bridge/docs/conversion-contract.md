# Conversion Contract

## Google success

All must be true:

1. runtime `about.importFormats` advertises PPTX → Google Slides;
2. resumable Drive upload/import succeeds;
3. Drive returns a file ID;
4. target MIME is `application/vnd.google-apps.presentation`;
5. Slides `presentations.get` succeeds.

Only then can `native` be `true`.

## Keynote success

All must be true:

1. runtime is macOS;
2. Keynote is installed;
3. `osascript` can address Keynote;
4. worker opens the controlled PPTX;
5. worker saves the document to `.key`;
6. the `.key` output exists after the command returns.

Only then can `native` be `true`.

## Simulation

Mock results use:

```json
{ "status": "simulated", "native": false, "verification": "mock" }
```

A simulated target never satisfies native acceptance.
