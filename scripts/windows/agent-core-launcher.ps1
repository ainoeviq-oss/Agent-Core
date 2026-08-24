[CmdletBinding()]
param(
  [switch]$ContractOnly,
  [switch]$Autostart,
  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\..'))
$trayScript = Join-Path $scriptDir 'agent-core-tray.ps1'
$tunnelProfile = Join-Path $root 'tunnel-client\agent-core.yaml'
$dataDir = Join-Path $root 'runtime\data'
$logDir = Join-Path $root 'runtime\logs'
$capabilityDir = Join-Path $root 'capabilities'
$localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
if (-not $localAppData) { $localAppData = [Environment]::GetFolderPath('LocalApplicationData') }
$locatorRootFile = Join-Path (Join-Path $localAppData 'AgentCore') 'root.txt'

function Resolve-ExistingPath {
  param([string]$EnvironmentName, [string]$CommandName, [string[]]$Candidates = @())
  if ($EnvironmentName) {
    $override = [Environment]::GetEnvironmentVariable($EnvironmentName, 'Process')
    if ($override -and (Test-Path -LiteralPath $override)) { return [IO.Path]::GetFullPath($override) }
  }
  if ($CommandName) {
    $command = Get-Command $CommandName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) {
      $candidate = if ($command.Source) { $command.Source } else { $command.Path }
      if ($candidate -and (Test-Path -LiteralPath $candidate)) { return [IO.Path]::GetFullPath($candidate) }
    }
  }
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return [IO.Path]::GetFullPath($candidate) }
  }
  return $null
}

function Resolve-NodeExe {
  $programFiles = [Environment]::GetFolderPath('ProgramFiles')
  return Resolve-ExistingPath 'AGENT_CORE_NODE_EXE' 'node.exe' @((Join-Path $programFiles 'nodejs\node.exe'))
}

function Resolve-NpmExe {
  param([string]$NodeExe)
  $candidates = @()
  if ($NodeExe) { $candidates += Join-Path (Split-Path -Parent $NodeExe) 'npm.cmd' }
  return Resolve-ExistingPath 'AGENT_CORE_NPM_EXE' 'npm.cmd' $candidates
}

function Resolve-TunnelExe {
  $candidates = @(
    (Join-Path $root 'tunnel-client\tunnel-client.exe'),
    (Join-Path $root 'tools\tunnel-client\tunnel-client.exe')
  )
  foreach ($drive in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    if ($drive.Root) { $candidates += Join-Path $drive.Root 'Apps\OpenAI-Tunnel-Client\v0.0.10\tunnel-client.exe' }
  }
  return Resolve-ExistingPath 'AGENT_CORE_TUNNEL_EXE' 'tunnel-client.exe' $candidates
}

$nodeExe = Resolve-NodeExe
$npmExe = Resolve-NpmExe $nodeExe
$tunnelExe = Resolve-TunnelExe

$contract = [ordered]@{
  root = $root
  trayScript = $trayScript
  tunnelProfile = $tunnelProfile
  dataDir = $dataDir
  logDir = $logDir
  capabilityDir = $capabilityDir
  nodeExe = $nodeExe
  npmExe = $npmExe
  tunnelExe = $tunnelExe
  launchMode = 'background-tray-bundle'
}
if ($ContractOnly) {
  Write-Output ($contract | ConvertTo-Json -Compress)
  exit 0
}

if (Test-Path -LiteralPath $locatorRootFile) {
  [IO.File]::WriteAllText($locatorRootFile, $root, (New-Object Text.UTF8Encoding($false)))
}

if (-not $nodeExe) { throw 'Node.js was not found. Install Node.js or set AGENT_CORE_NODE_EXE.' }
if (-not $npmExe) { throw 'npm.cmd was not found. Install npm or set AGENT_CORE_NPM_EXE.' }
if (-not $tunnelExe) { throw 'Tunnel client was not found. Set AGENT_CORE_TUNNEL_EXE or install OpenAI Tunnel Client.' }
foreach ($required in @($trayScript, $tunnelProfile)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required Agent Core file not found: $required" }
}

$dependencyMarker = Join-Path $root 'node_modules\@modelcontextprotocol\sdk\package.json'
Push-Location $root
try {
  if (-not (Test-Path -LiteralPath $dependencyMarker)) {
    $installVerb = if (Test-Path -LiteralPath (Join-Path $root 'package-lock.json')) { 'ci' } else { 'install' }
    & $npmExe $installVerb
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed with exit code $LASTEXITCODE" }
  }
  if (-not $SkipBuild) {
    & $npmExe run build
    if ($LASTEXITCODE -ne 0) { throw "Agent Core build failed with exit code $LASTEXITCODE" }
  }
} finally {
  Pop-Location
}

$env:AGENT_CORE_NODE_EXE = $nodeExe
$env:AGENT_CORE_TUNNEL_EXE = $tunnelExe
$env:AGENT_CORE_HOME = $root
$env:AGENT_CORE_DATA_DIR = $dataDir
$env:AGENT_CORE_LOG_DIR = $logDir
$env:AGENT_CORE_CAPABILITY_DIR = $capabilityDir
$env:AGENT_CORE_ALLOWED_ROOTS = $root

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $trayScript -Mode ControlledTakeover | Out-Null
$takeoverExit = $LASTEXITCODE
if ($takeoverExit -ne 0 -and $takeoverExit -ne 23) {
  throw "Controlled takeover failed with exit code $takeoverExit"
}

$quotedTray = '"' + $trayScript + '"'
$args = @('-NoLogo','-NoProfile','-STA','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$quotedTray,'-Mode','Tray')
Start-Process -FilePath 'powershell.exe' -ArgumentList $args -WindowStyle Hidden | Out-Null

$deadline = [DateTime]::UtcNow.AddSeconds(20)
$agentOk = $false
$tunnelOk = $false
do {
  try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2
    $agentOk = ($health.status -eq 'ok')
  } catch { $agentOk = $false }
  try {
    $ready = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8787/readyz' -TimeoutSec 2
    $tunnelOk = ([int]$ready.StatusCode -eq 200)
  } catch { $tunnelOk = $false }
  if ($agentOk -and $tunnelOk) { break }
  Start-Sleep -Milliseconds 300
} while ([DateTime]::UtcNow -lt $deadline)

if (-not ($agentOk -and $tunnelOk)) {
  throw "Agent Core bundle did not become healthy in time (mcp=$agentOk tunnel=$tunnelOk). Check runtime\tray logs."
}

Write-Output 'Agent Core is running in the background. Use the Agent Core tray icon for status, restart, OAuth reset, autostart, and exit.'
exit 0

