Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$taskName = 'Agent Core Tray Manager'
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
if (-not $localAppData) { $localAppData = [Environment]::GetFolderPath('LocalApplicationData') }
$locatorDir = Join-Path $localAppData 'AgentCore'
if (Test-Path -LiteralPath $locatorDir) {
  Remove-Item -LiteralPath $locatorDir -Recurse -Force -ErrorAction SilentlyContinue
}
