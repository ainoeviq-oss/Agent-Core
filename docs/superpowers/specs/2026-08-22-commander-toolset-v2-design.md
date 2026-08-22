# Commander Toolset V2 Design

## Goal
Turn the authenticated Commander MCP gateway into a practical local-computer tool server while preserving path boundaries, command guardrails, auditability, and the existing OAuth/API-key bridge.

## V2 tool surface
- `commander_status`
- `commander_capabilities`
- `workspace_info`
- `list_directory`
- `read_file`
- `read_multiple_files`
- `write_file`
- `edit_file`
- `create_directory`
- `move_file`
- `get_file_info`
- `search_files`
- `execute_command`
- `start_process`
- `read_process_output`
- `stop_process`
- `list_processes`

## Workspace policy
`COMMANDER_ALLOWED_ROOTS` is a semicolon-separated list of Windows roots. Every filesystem target and command working directory must resolve inside one of these roots. Existing paths are checked through `realpath` to prevent symlink/junction escapes; new paths are checked through their nearest existing parent.

If the variable is absent, the server defaults to its current working directory rather than unrestricted filesystem access.

## Filesystem behavior
Text reads are bounded by bytes and optional line ranges. Writes support rewrite or append. `edit_file` performs exact-string replacement and rejects ambiguous replacement counts. Directory listing is depth-bounded and result-limited. Search supports filename and text-content modes with deterministic result limits.

## Process behavior
Commands run through PowerShell on Windows. A blocked-command policy rejects high-risk system/storage/privilege commands before execution. `execute_command` is bounded by timeout and output size. Long-running processes receive opaque session IDs and retain bounded stdout/stderr buffers for later reads. Sessions can be stopped explicitly.

## Safety and observability
No tool returns raw API keys, OAuth tokens, or tunnel credentials. Tool errors are returned as MCP tool errors rather than crashing the server. Existing request audit logging remains active. Filesystem mutations and process execution remain attributable to the authenticated Commander key identity.

## Deferred after V2
Git-specific semantic tools, registry/system administration, GUI automation, application-specific adapters, streaming search sessions, and per-key capability scopes remain separate follow-up stages.
