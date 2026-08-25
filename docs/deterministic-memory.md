# Agent Core Deterministic Memory Fabric

Deterministic Memory Fabric (DMF) is an in-process Agent Core subsystem. It uses the existing Agent Core Node.js process plus an internal SQLite worker thread; there is no separate memory server, model, embedding service, or vector database.

DMF is enabled by default. Structured hard-guardrail enforcement remains disabled by default and is controlled separately by `AGENT_CORE_MEMORY_ENFORCE_HARD_GUARDRAILS`.

## Runtime locations

With the normal unified launcher, the primary database is:

```text
<Agent-Core-root>\runtime\memory\agent-core-memory.sqlite
```

Automatic/pre-operation backups are kept under:

```text
<Agent-Core-root>\runtime\memory\backups\
```

`last-backup.json` in that backup directory records the latest successful backup path, timestamp, and reason. WAL/SHM files are SQLite sidecars and are checkpointed on clean Agent Core shutdown.

## Health and diagnostics

Use `agent_core_status` or `memory_status` from the Agent Core MCP surface. The HTTP health endpoint also reports memory diagnostics:

```text
GET http://127.0.0.1:8765/health
```

Important states:

- `healthy`: SQLite opened, migrations/integrity checks succeeded, and DMF is available.
- `degraded`: DMF failed closed. Agent Core OAuth/MCP can remain available, but memory recall returns no invented evidence.
- `disabled`: DMF was explicitly disabled.
- `closed`: Agent Core has closed the in-process memory worker.

A degraded memory database is reported separately by the tray; it is not treated as an unavailable MCP server by itself.

## Clean tray shutdown on Windows

Windows PowerShell `Stop-Process` does not deliver Node.js `SIGTERM`/`SIGINT` handlers. The unified tray therefore does not rely on those signals for normal Agent Core restarts or exit.

For an owned Agent Core process, the tray writes a local shutdown request under `runtime\tray\agent-core.shutdown.request`. The Agent Core process watches that file in-process, closes the HTTP listener, checkpoints/closes the SQLite memory worker, consumes the request, and exits. The tray waits for that clean exit before using process termination as a bounded fallback.

The fallback remains necessary for a hung or legacy process; SQLite WAL/crash recovery is still tested for that case. A normal current-version tray stop should finish without leaving memory `-wal` or `-shm` sidecars.

## Export memory safely

`memory_export` is a bounded, read-only diagnostic/backup view for the authenticated principal and current project. It exports memory items, revisions, safe redacted event provenance, and conflicts. It does not export the raw `memory_events.raw_text` field.

For a diagnostic capture, call `memory_export` with a bounded `limit` and save the returned JSON to an operator-controlled file if needed. The model-facing tool does not write an export file automatically.

Use `memory_explain` when the goal is to understand why one memory matched: it reports revision history, anchors, graph edges, provenance, and optional query-score evidence.

## Forget memory

`memory_forget` is intentionally soft. It tombstones the selected memory so it is excluded from active recall while preserving revisions and audit evidence.

Physical purge is **not** exposed through the model-facing MCP tool. A relevance score can never physically delete evidence. Any future physical purge policy must remain an explicit operator action and must take a backup first.

## Backup behavior

DMF creates a timestamped SQLite backup before a destructive/forward schema migration. The service also has an internal operator backup primitive used by recovery tests and maintenance code.

A backup name includes the database base name, UTC timestamp, and reason, for example:

```text
agent-core-memory.2026-08-25T02-00-00-000Z.pre-migration-v1-to-v2.sqlite
```

Backups use SQLite `VACUUM INTO` through the dedicated memory worker so the copied database is consistent. Backup integrity is checked during restore.

## Recovery and restore

### Normal recovery

1. Exit Agent Core from the tray (`Exit Agent Core`) so the SQLite worker checkpoints WAL and closes cleanly.
2. Inspect `runtime\memory\backups\last-backup.json` and select the required backup.
3. Restore only while Agent Core is stopped.
4. Restart with `Start-Agent-Core.bat`.
5. Verify `/health`, `agent_core_status`, or `memory_status` reports `healthy` and `integrity: ok`.

The tested restore implementation validates the source backup, creates a pre-restore backup of the current database when possible, removes stale WAL/SHM sidecars, stages the replacement in the same directory, atomically renames it into place, validates the restored DB, and rolls back if validation fails.

### Operator restore API

The restore primitive is intentionally not exposed as an MCP model tool. After `npm run build`, an operator can invoke it from the Agent Core root while Agent Core is stopped. Set the selected backup path first:

```powershell
$env:MEMORY_BACKUP_PATH = 'F:\path\to\agent-core-memory.<timestamp>.<reason>.sqlite'
@'
import path from 'node:path';
import { restoreMemoryDatabase } from './dist/memory/backup.js';

const result = await restoreMemoryDatabase({
  dbPath: path.resolve('runtime', 'memory', 'agent-core-memory.sqlite'),
  backupPath: process.env.MEMORY_BACKUP_PATH,
  serviceStopped: true,
});
console.log(JSON.stringify(result, null, 2));
'@ | node --input-type=module
```

Do not copy over a live database while Agent Core is running.

## Disable DMF for an operator diagnostic

DMF can be disabled without removing the database. Exit the tray first, then start Agent Core from a diagnostic shell with memory disabled:

```powershell
$env:AGENT_CORE_MEMORY_ENABLED = 'false'
node dist\index.js
```

`capability_route` and existing operational tools continue to work; memory status is reported as disabled and no memory evidence is fabricated.

To return to normal unified-launcher operation, stop that diagnostic process, clear the temporary override, and use the normal launcher:

```powershell
Remove-Item Env:AGENT_CORE_MEMORY_ENABLED -ErrorAction SilentlyContinue
.\Start-Agent-Core.bat
```

The normal unified launcher enables DMF and binds the database to `runtime\memory\agent-core-memory.sqlite` inside the current Agent Core root.

## Secret handling

DMF redacts secret-like keys and text before indexing/persistence used by recall. Memory search/export must not echo plaintext API keys, authorization values, passwords, access/refresh tokens, or similar known secret patterns.

The raw Agent Core API key itself is not required by the memory database. Authentication/key storage remains a separate Agent Core subsystem.

## Deterministic behavior

For identical database state, scope, query, and configuration, recall ordering and snapshot hash are deterministic. Retrieval combines SQLite FTS5/BM25, exact structured anchors, bounded graph expansion, weighted Personalized PageRank, state/importance/recency scoring, and explicit provenance. No hidden AI performs extraction, embeddings, reranking, contradiction resolution, or cleanup.
