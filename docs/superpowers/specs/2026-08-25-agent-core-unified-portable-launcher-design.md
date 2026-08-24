# Agent Core Unified Portable Launcher Design

## Goal
Make `Start-Agent-Core.bat` the only user-facing launcher. One double-click boots Agent Core MCP, tunnel, tray UI, watchdog, OAuth reset support, and background lifecycle management.

## Canonical root
`F:\Projects\Agent-Core` is the only production checkout after acceptance. Recovery/migration/tray work folders are temporary sources only and are deleted after unique changes are proven superseded.

## Portability contract
Runtime paths are derived from the launcher/script location, not from a fixed drive or Git common-dir metadata. Node and tunnel executables are discovered from overrides/PATH/known install candidates. Moving the stopped Agent Core folder and launching `Start-Agent-Core.bat` from the new location rebinds data, logs, capabilities, tunnel profile, tray state, and autostart locator to the new root.

## Safety
Never delete `runtime\data`, `secrets`, capabilities, or custom key state during launcher cleanup. Never print API key values. Folder cleanup happens only after build/tests/live health pass.
