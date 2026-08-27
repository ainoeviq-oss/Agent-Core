# Google Slides Integration

## APIs

Presentation Bridge uses Google Drive API for PPTX → native Google Slides import and Google Slides API for target inspection/repair.

Runtime logic:

```text
about.importFormats
      ↓
confirm PPTX → application/vnd.google-apps.presentation
      ↓
Drive files.create resumable upload with target Google Slides MIME
      ↓
verify returned native MIME
      ↓
Slides presentations.get
```

## OAuth

Use a **Desktop app** OAuth client in a Google Cloud project with Drive API and Slides API enabled.

Copy the downloaded client JSON to:

```text
secrets/google/oauth-client.json
```

Then:

```bash
npm run build
node dist/src/cli/index.js google auth
node dist/src/cli/index.js google doctor
```

The implementation uses PKCE plus a random `127.0.0.1` loopback callback. It requests only `drive.file`.

## Live acceptance

```bash
node dist/src/cli/index.js convert corpus/generated/12-complex-real-world.pptx \
  --target google --output runtime/acceptance/google
```

Acceptance requires `native: true`, `verification: "live"`, a native MIME type, file ID, and a successful Slides structural read.

## Official references

- Google Drive About/import formats: https://developers.google.com/workspace/drive/api/reference/rest/v3/about
- Drive files.create: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create
- Drive scopes: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- Desktop OAuth / PKCE / loopback: https://developers.google.com/identity/protocols/oauth2/native-app
- Slides API: https://developers.google.com/workspace/slides/api/reference/rest
