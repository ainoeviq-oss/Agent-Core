[CmdletBinding()]
param(
  [ValidateSet('Tray','Probe','StartBundle','StopBundle','RestartBundle','ResetOAuth','ControlledTakeover','WatchdogTick','TrayExit')]
  [string]$Mode = 'Tray',
  [string]$ConfigPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:ScriptPath = $MyInvocation.MyCommand.Path
$script:ScriptDir = Split-Path -Parent $script:ScriptPath

function Get-CurrentUserSid {
  try {
    return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  } catch {
    return [Environment]::UserName
  }
}

function Resolve-AgentCoreExecutable {
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

function Resolve-AgentCoreNodeExe {
  $programFiles = [Environment]::GetFolderPath('ProgramFiles')
  return Resolve-AgentCoreExecutable 'AGENT_CORE_NODE_EXE' 'node.exe' @((Join-Path $programFiles 'nodejs\node.exe'))
}

function Resolve-AgentCoreTunnelExe {
  param([string]$Root)
  $candidates = @(
    (Join-Path $Root 'tunnel-client\tunnel-client.exe'),
    (Join-Path $Root 'tools\tunnel-client\tunnel-client.exe')
  )
  foreach ($drive in @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue)) {
    if ($drive.Root) { $candidates += Join-Path $drive.Root 'Apps\OpenAI-Tunnel-Client\v0.0.10\tunnel-client.exe' }
  }
  return Resolve-AgentCoreExecutable 'AGENT_CORE_TUNNEL_EXE' 'tunnel-client.exe' $candidates
}
function Get-AgentCoreTrayConfig {
  param([string]$OverridePath = '')
  $root = [IO.Path]::GetFullPath((Join-Path $script:ScriptDir '..\..'))
  $nodeExe = Resolve-AgentCoreNodeExe
  $tunnelExe = Resolve-AgentCoreTunnelExe $root
  $defaults = [ordered]@{
    root = $root
    trayRuntimeDir = Join-Path $root 'runtime\tray'
    agentCorePort = 8765
    tunnelPort = 8787
    nodeExe = $nodeExe
    agentCoreEntry = Join-Path $root 'dist\index.js'
    agentCoreCli = Join-Path $root 'dist\cli.js'
    tunnelExe = $tunnelExe
    tunnelProfile = Join-Path $root 'tunnel-client\agent-core.yaml'
    watchdogIntervalSeconds = 10
    failureThreshold = 3
    restartLimit = 3
    restartWindowSeconds = 300
    mutexName = ('Local\AgentCoreTray-' + (Get-CurrentUserSid))
    holdMutexSeconds = 0
  }

  if ($OverridePath) {
    if (-not (Test-Path -LiteralPath $OverridePath)) {
      throw "Tray config not found: $OverridePath"
    }
    $override = Get-Content -LiteralPath $OverridePath -Raw | ConvertFrom-Json
    foreach ($property in $override.PSObject.Properties) {
      $defaults[$property.Name] = $property.Value
    }
  }

  foreach ($name in @('root','trayRuntimeDir','nodeExe','agentCoreEntry','agentCoreCli','tunnelExe','tunnelProfile')) {
    if ($defaults[$name]) {
      $defaults[$name] = [IO.Path]::GetFullPath([string]$defaults[$name])
    }
  }
  return [pscustomobject]$defaults
}

function Get-StatePath {
  param($Config)
  return Join-Path ([string]$Config.trayRuntimeDir) 'state.json'
}

function Read-TrayState {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try {
    return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function New-EmptyTrayState {
  return [pscustomobject]@{
    services = [pscustomobject]@{}
  }
}

function Write-TrayState {
  param([string]$Path, $State)
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $json = $State | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-PortOwnerProcess {
  param([int]$Port)
  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $connection) { return $null }
  $processId = [int]$connection.OwningProcess
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  return [pscustomobject]@{
    ProcessId = [int]$process.ProcessId
    ExecutablePath = [string]$process.ExecutablePath
    CommandLine = [string]$process.CommandLine
  }
}

function Get-ProcessInfoById {
  param([int]$ProcessId)
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
  if (-not $process) { return $null }
  return [pscustomobject]@{
    ProcessId = [int]$process.ProcessId
    ExecutablePath = [string]$process.ExecutablePath
    CommandLine = [string]$process.CommandLine
  }
}

function Test-PathEqual {
  param([string]$Left, [string]$Right)
  if (-not $Left -or -not $Right) { return $false }
  try {
    $a = [IO.Path]::GetFullPath($Left)
    $b = [IO.Path]::GetFullPath($Right)
    return [string]::Equals($a, $b, [StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Test-ServiceIdentity {
  param($ProcessInfo, $Expected)
  if (-not $ProcessInfo) { return $false }
  if (-not (Test-PathEqual $ProcessInfo.ExecutablePath $Expected.ExecutablePath)) { return $false }
  if ([int]$ProcessInfo.ProcessId -ne [int]$Expected.PortOwnerPid) { return $false }
  foreach ($token in @($Expected.CommandLineTokens)) {
    if (-not $token) { continue }
    if ($ProcessInfo.CommandLine.IndexOf([string]$token, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
      return $false
    }
  }
  if ($Expected.PSObject.Properties['CommandLineAnyTokens']) {
    $matchedAlternative = $false
    foreach ($token in @($Expected.CommandLineAnyTokens)) {
      if (-not $token) { continue }
      if ($ProcessInfo.CommandLine.IndexOf([string]$token, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $matchedAlternative = $true
        break
      }
    }
    if (-not $matchedAlternative) { return $false }
  }
  return $true
}

function Get-ServiceExpectation {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config, [int]$PortOwnerPid)
  if ($Role -eq 'agentCore') {
    $entry = [IO.Path]::GetFullPath([string]$Config.agentCoreEntry)
    $root = [IO.Path]::GetFullPath([string]$Config.root)
    $rootPrefix = if ($root.EndsWith([string][IO.Path]::DirectorySeparatorChar)) { $root } else { $root + [IO.Path]::DirectorySeparatorChar }
    $entrySignatures = @($entry)
    if ($entry.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
      $relativeEntry = $entry.Substring($rootPrefix.Length)
      $entrySignatures += $relativeEntry
      $entrySignatures += $relativeEntry.Replace('\','/')
    }
    return [pscustomobject]@{
      ExecutablePath = [string]$Config.nodeExe
      PortOwnerPid = $PortOwnerPid
      CommandLineTokens = @()
      CommandLineAnyTokens = @($entrySignatures | Select-Object -Unique)
    }
  }
  $tokens = @()
  if ($Config.PSObject.Properties['tunnelEntry'] -and $Config.tunnelEntry) {
    $tokens += [string]$Config.tunnelEntry
  }
  $tokens += '--profile-file'
  $tokens += [string]$Config.tunnelProfile
  return [pscustomobject]@{
    ExecutablePath = [string]$Config.tunnelExe
    PortOwnerPid = $PortOwnerPid
    CommandLineTokens = $tokens
  }
}

function Remove-StateService {
  param($State, [string]$Role)
  if ($State.services -and $State.services.PSObject.Properties[$Role]) {
    $State.services.PSObject.Properties.Remove($Role)
  }
}

function Reclaim-TrayState {
  param($Config)
  $statePath = Get-StatePath $Config
  $state = Read-TrayState $statePath
  if (-not $state) { $state = New-EmptyTrayState }
  if (-not $state.PSObject.Properties['services'] -or -not $state.services) {
    $state | Add-Member -NotePropertyName services -NotePropertyValue ([pscustomobject]@{}) -Force
  }

  foreach ($role in @('agentCore','tunnel')) {
    $entryProperty = $state.services.PSObject.Properties[$role]
    if (-not $entryProperty) { continue }
    $entry = $entryProperty.Value
    $pidProperty = $entry.PSObject.Properties['pid']
    if (-not $pidProperty) {
      Remove-StateService $state $role
      continue
    }

    $port = if ($role -eq 'agentCore') { [int]$Config.agentCorePort } else { [int]$Config.tunnelPort }
    $owner = Get-PortOwnerProcess $port
    $process = Get-ProcessInfoById ([int]$pidProperty.Value)
    $ownerPid = if ($owner) { [int]$owner.ProcessId } else { -1 }
    $expected = Get-ServiceExpectation $role $Config $ownerPid
    if (-not (Test-ServiceIdentity $process $expected)) {
      Remove-StateService $state $role
    }
  }

  Write-TrayState $statePath $state
  return $state
}

function Acquire-TrayMutex {
  param($Config)
  $mutex = New-Object Threading.Mutex($false, [string]$Config.mutexName)
  $acquired = $false
  try {
    $acquired = $mutex.WaitOne(0, $false)
  } catch [Threading.AbandonedMutexException] {
    $acquired = $true
  }
  return [pscustomobject]@{ Mutex = $mutex; Acquired = $acquired }
}

function Release-TrayMutex {
  param($Handle)
  if (-not $Handle) { return }
  if ($Handle.Acquired) {
    try { $Handle.Mutex.ReleaseMutex() } catch {}
  }
  $Handle.Mutex.Dispose()
}

function Get-ProbeService {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config)
  $port = if ($Role -eq 'agentCore') { [int]$Config.agentCorePort } else { [int]$Config.tunnelPort }
  $owner = Get-PortOwnerProcess $port
  if (-not $owner) {
    return [pscustomobject]@{ pid = $null; identityMatch = $false; healthy = $false }
  }
  $healthy = if ($Role -eq 'agentCore') { Test-AgentCoreHealth $Config } else { Test-TunnelHealth $Config }
  $expected = Get-ServiceExpectation $Role $Config ([int]$owner.ProcessId)
  return [pscustomobject]@{
    pid = [int]$owner.ProcessId
    identityMatch = [bool](Test-ServiceIdentity $owner $expected)
    healthy = [bool]$healthy
  }
}

function Invoke-Probe {
  param($Config)
  Reclaim-TrayState $Config | Out-Null
  $body = [ordered]@{
    status = 'ok'
    root = [string]$Config.root
    agentCorePort = [int]$Config.agentCorePort
    tunnelPort = [int]$Config.tunnelPort
    agentCore = Get-ProbeService 'agentCore' $Config
    tunnel = Get-ProbeService 'tunnel' $Config
  }
  Write-Output ($body | ConvertTo-Json -Depth 6 -Compress)
  $hold = 0
  if ($Config.PSObject.Properties['holdMutexSeconds']) {
    $hold = [int]$Config.holdMutexSeconds
  }
  if ($hold -gt 0) { Start-Sleep -Seconds $hold }
}


function Get-ServiceStateEntry {
  param($Config, [ValidateSet('agentCore','tunnel')][string]$Role)
  $state = Read-TrayState (Get-StatePath $Config)
  if (-not $state -or -not $state.services -or -not $state.services.PSObject.Properties[$Role]) {
    return $null
  }
  return $state.services.PSObject.Properties[$Role].Value
}

function Set-ServiceStateEntry {
  param($Config, [ValidateSet('agentCore','tunnel')][string]$Role, [int]$ProcessId, [string]$Origin)
  $path = Get-StatePath $Config
  $state = Read-TrayState $path
  if (-not $state) { $state = New-EmptyTrayState }
  if (-not $state.PSObject.Properties['services'] -or -not $state.services) {
    $state | Add-Member -NotePropertyName services -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $entry = [pscustomobject]@{
    role = $Role
    pid = $ProcessId
    origin = $Origin
    startedAt = [DateTime]::UtcNow.ToString('o')
    healthState = 'Running'
    consecutiveFailures = 0
    restartHistory = @()
  }
  $state.services | Add-Member -NotePropertyName $Role -NotePropertyValue $entry -Force
  Write-TrayState $path $state
  return $entry
}

function Clear-ServiceStateEntry {
  param($Config, [ValidateSet('agentCore','tunnel')][string]$Role)
  $path = Get-StatePath $Config
  $state = Read-TrayState $path
  if (-not $state) { $state = New-EmptyTrayState }
  Remove-StateService $state $Role
  Write-TrayState $path $state
}

function Get-ServiceStatus {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config)
  $probe = Get-ProbeService $Role $Config
  $entry = Get-ServiceStateEntry $Config $Role
  $owned = $false
  if ($entry -and $probe.pid -and ([int]$entry.pid -eq [int]$probe.pid) -and $probe.identityMatch) {
    $owned = $true
  }
  return [pscustomobject]@{
    pid = $probe.pid
    identityMatch = [bool]$probe.identityMatch
    owned = $owned
  }
}

function Test-AgentCoreHealth {
  param($Config)
  try {
    $response = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f [int]$Config.agentCorePort) -TimeoutSec 2
    return ($response.status -eq 'ok')
  } catch {
    return $false
  }
}

function Test-TunnelHealth {
  param($Config)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/readyz" -f [int]$Config.tunnelPort) -TimeoutSec 2
    return ([int]$response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Wait-ServiceHealthy {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config, [int]$TimeoutSeconds = 10)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $probe = Get-ProbeService $Role $Config
    $healthy = if ($Role -eq 'agentCore') { Test-AgentCoreHealth $Config } else { Test-TunnelHealth $Config }
    if ($probe.identityMatch -and $healthy) { return $probe }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  return $null
}

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Ensure-TrayRuntimeDir {
  param($Config)
  if (-not (Test-Path -LiteralPath $Config.trayRuntimeDir)) {
    New-Item -ItemType Directory -Path $Config.trayRuntimeDir -Force | Out-Null
  }
}

function Get-AgentCoreDataDir {
  param($Config)
  return Join-Path ([string]$Config.root) 'runtime\data'
}

function Get-LegacyAgentCoreDataDir {
  param($Config)
  return Join-Path ([string]$Config.root) 'runtime\data-current'
}

function Start-AgentCoreService {
  param($Config)
  $current = Get-ServiceStatus 'agentCore' $Config
  if ($current.owned -and (Test-AgentCoreHealth $Config)) {
    return [pscustomobject]@{ action = 'already_owned'; pid = $current.pid; ok = $true }
  }
  if ($current.pid) {
    return [pscustomobject]@{ action = 'degraded'; reason = 'port_in_use_unowned'; pid = $current.pid; ok = $false }
  }
  if (-not (Test-Path -LiteralPath $Config.nodeExe)) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'node_missing'; ok = $false }
  }
  if (-not (Test-Path -LiteralPath $Config.agentCoreEntry)) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'entry_missing'; ok = $false }
  }

  Ensure-TrayRuntimeDir $Config
  $stdin = Join-Path $Config.trayRuntimeDir 'stdin.null'
  if (-not (Test-Path -LiteralPath $stdin)) { [IO.File]::WriteAllBytes($stdin, [byte[]]@()) }
  $stdout = Join-Path $Config.trayRuntimeDir 'agent-core.stdout.log'
  $stderr = Join-Path $Config.trayRuntimeDir 'agent-core.stderr.log'
  $envNames = @(
    'AGENT_CORE_DATA_DIR','AGENT_CORE_LOG_DIR','AGENT_CORE_CAPABILITY_DIR',
    'AGENT_CORE_ALLOWED_ROOTS','AGENT_CORE_HOST','AGENT_CORE_PORT'
  )
  $newValues = [ordered]@{
    AGENT_CORE_DATA_DIR = Get-AgentCoreDataDir $Config
    AGENT_CORE_LOG_DIR = Join-Path $Config.root 'runtime\logs'
    AGENT_CORE_CAPABILITY_DIR = Join-Path $Config.root 'capabilities'
    AGENT_CORE_ALLOWED_ROOTS = [string]$Config.root
    AGENT_CORE_HOST = '127.0.0.1'
    AGENT_CORE_PORT = [string]$Config.agentCorePort
  }
  $oldValues = @{}
  foreach ($name in $envNames) {
    $oldValues[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, [string]$newValues[$name], 'Process')
  }
  try {
    $process = Start-Process -FilePath $Config.nodeExe `
      -ArgumentList @((Quote-ProcessArgument $Config.agentCoreEntry)) `
      -WorkingDirectory $Config.root -WindowStyle Hidden `
      -RedirectStandardInput $stdin -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  } finally {
    foreach ($name in $envNames) {
      [Environment]::SetEnvironmentVariable($name, $oldValues[$name], 'Process')
    }
  }

  $probe = Wait-ServiceHealthy 'agentCore' $Config
  if (-not $probe) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'health_timeout'; pid = $process.Id; ok = $false }
  }
  Set-ServiceStateEntry $Config 'agentCore' ([int]$probe.pid) 'started' | Out-Null
  return [pscustomobject]@{ action = 'started'; pid = [int]$probe.pid; ok = $true }
}

function Get-TunnelArgumentList {
  param($Config)
  $arguments = @()
  if ($Config.PSObject.Properties['tunnelEntry'] -and $Config.tunnelEntry) {
    $arguments += Quote-ProcessArgument ([string]$Config.tunnelEntry)
  }
  $arguments += 'run'
  $arguments += '--profile-file'
  $arguments += Quote-ProcessArgument ([string]$Config.tunnelProfile)
  $arguments += '--harpoon.allow-plaintext-http'
  return $arguments
}

function Start-TunnelService {
  param($Config)
  $current = Get-ServiceStatus 'tunnel' $Config
  if ($current.owned -and (Test-TunnelHealth $Config)) {
    return [pscustomobject]@{ action = 'already_owned'; pid = $current.pid; ok = $true }
  }
  if ($current.pid) {
    return [pscustomobject]@{ action = 'degraded'; reason = 'port_in_use_unowned'; pid = $current.pid; ok = $false }
  }
  if (-not (Test-Path -LiteralPath $Config.tunnelExe)) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'tunnel_exe_missing'; ok = $false }
  }
  if (-not (Test-Path -LiteralPath $Config.tunnelProfile)) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'tunnel_profile_missing'; ok = $false }
  }
  if ($Config.PSObject.Properties['tunnelEntry'] -and $Config.tunnelEntry -and -not (Test-Path -LiteralPath $Config.tunnelEntry)) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'tunnel_entry_missing'; ok = $false }
  }

  Ensure-TrayRuntimeDir $Config
  $stdin = Join-Path $Config.trayRuntimeDir 'stdin.null'
  if (-not (Test-Path -LiteralPath $stdin)) { [IO.File]::WriteAllBytes($stdin, [byte[]]@()) }
  $stdout = Join-Path $Config.trayRuntimeDir 'tunnel.stdout.log'
  $stderr = Join-Path $Config.trayRuntimeDir 'tunnel.stderr.log'
  $process = Start-Process -FilePath $Config.tunnelExe `
    -ArgumentList (Get-TunnelArgumentList $Config) `
    -WorkingDirectory $Config.root -WindowStyle Hidden `
    -RedirectStandardInput $stdin -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru

  $probe = Wait-ServiceHealthy 'tunnel' $Config
  if (-not $probe) {
    return [pscustomobject]@{ action = 'faulted'; reason = 'health_timeout'; pid = $process.Id; ok = $false }
  }
  Set-ServiceStateEntry $Config 'tunnel' ([int]$probe.pid) 'started' | Out-Null
  return [pscustomobject]@{ action = 'started'; pid = [int]$probe.pid; ok = $true }
}

function Stop-OwnedService {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config)
  $entry = Get-ServiceStateEntry $Config $Role
  if (-not $entry) { return [pscustomobject]@{ action = 'no_state'; ok = $true } }

  $port = if ($Role -eq 'agentCore') { [int]$Config.agentCorePort } else { [int]$Config.tunnelPort }
  $owner = Get-PortOwnerProcess $port
  $process = Get-ProcessInfoById ([int]$entry.pid)
  $ownerPid = if ($owner) { [int]$owner.ProcessId } else { -1 }
  $expected = Get-ServiceExpectation $Role $Config $ownerPid
  if (-not (Test-ServiceIdentity $process $expected)) {
    Clear-ServiceStateEntry $Config $Role
    return [pscustomobject]@{ action = 'identity_mismatch'; ok = $false }
  }

  Stop-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while ((Get-ProcessInfoById ([int]$entry.pid)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  $remaining = Get-ProcessInfoById ([int]$entry.pid)
  if ($remaining) {
    $owner2 = Get-PortOwnerProcess $port
    $ownerPid2 = if ($owner2) { [int]$owner2.ProcessId } else { -1 }
    $expected2 = Get-ServiceExpectation $Role $Config $ownerPid2
    if (Test-ServiceIdentity $remaining $expected2) {
      Stop-Process -Id ([int]$entry.pid) -Force -ErrorAction SilentlyContinue
    }
  }
  Clear-ServiceStateEntry $Config $Role
  return [pscustomobject]@{ action = 'stopped'; pid = [int]$entry.pid; ok = $true }
}

function Start-Bundle {
  param($Config)
  Reclaim-TrayState $Config | Out-Null
  $agent = Start-AgentCoreService $Config
  $tunnel = Start-TunnelService $Config
  $status = if ($agent.ok -and $tunnel.ok) { 'running' } else { 'degraded' }
  return [pscustomobject]@{ status = $status; agentCore = $agent; tunnel = $tunnel }
}

function Stop-Bundle {
  param($Config)
  $tunnel = Stop-OwnedService 'tunnel' $Config
  $agent = Stop-OwnedService 'agentCore' $Config
  return [pscustomobject]@{ status = 'stopped'; agentCore = $agent; tunnel = $tunnel }
}

function Get-ProfilePathFromCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $null }
  $match = [regex]::Match($CommandLine, '--profile-file\s+(?:"([^"]+)"|(\S+))', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) { return $null }
  if ($match.Groups[1].Success) { return $match.Groups[1].Value }
  return $match.Groups[2].Value
}

function Stop-ControlledTakeoverProcess {
  param($ProcessInfo, $Expected)
  if (-not (Test-ServiceIdentity $ProcessInfo $Expected)) { return $false }
  Stop-Process -Id ([int]$ProcessInfo.ProcessId) -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while ((Get-ProcessInfoById ([int]$ProcessInfo.ProcessId)) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  $remaining = Get-ProcessInfoById ([int]$ProcessInfo.ProcessId)
  if ($remaining) {
    Stop-Process -Id ([int]$ProcessInfo.ProcessId) -Force -ErrorAction SilentlyContinue
  }
  return $true
}

function Invoke-ControlledTakeover {
  param($Config)
  Reclaim-TrayState $Config | Out-Null
  $agentResult = [pscustomobject]@{ action = 'absent' }
  $tunnelResult = [pscustomobject]@{ action = 'absent' }

  $agentOwner = Get-PortOwnerProcess ([int]$Config.agentCorePort)
  if ($agentOwner) {
    $expected = Get-ServiceExpectation 'agentCore' $Config ([int]$agentOwner.ProcessId)
    if ((Test-ServiceIdentity $agentOwner $expected) -and (Test-AgentCoreHealth $Config)) {
      Set-ServiceStateEntry $Config 'agentCore' ([int]$agentOwner.ProcessId) 'adopted' | Out-Null
      $agentResult = [pscustomobject]@{ action = 'adopted'; pid = [int]$agentOwner.ProcessId }
    } else {
      $agentResult = [pscustomobject]@{ action = 'denied'; pid = [int]$agentOwner.ProcessId }
    }
  }

  $tunnelOwner = Get-PortOwnerProcess ([int]$Config.tunnelPort)
  if ($tunnelOwner) {
    $canonical = Get-ServiceExpectation 'tunnel' $Config ([int]$tunnelOwner.ProcessId)
    if ((Test-ServiceIdentity $tunnelOwner $canonical) -and (Test-TunnelHealth $Config)) {
      Set-ServiceStateEntry $Config 'tunnel' ([int]$tunnelOwner.ProcessId) 'adopted' | Out-Null
      $tunnelResult = [pscustomobject]@{ action = 'adopted'; pid = [int]$tunnelOwner.ProcessId }
    } elseif (Test-PathEqual $tunnelOwner.ExecutablePath $Config.tunnelExe) {
      $oldProfile = Get-ProfilePathFromCommandLine $tunnelOwner.CommandLine
      $isNonCanonical = $oldProfile -and -not (Test-PathEqual $oldProfile $Config.tunnelProfile)
      $missing = $oldProfile -and -not (Test-Path -LiteralPath $oldProfile)
      if ($isNonCanonical -and $missing) {
        $staleExpected = [pscustomobject]@{
          ExecutablePath = [string]$Config.tunnelExe
          PortOwnerPid = [int]$tunnelOwner.ProcessId
          CommandLineTokens = @('--profile-file', [string]$oldProfile)
        }
        if (Stop-ControlledTakeoverProcess $tunnelOwner $staleExpected) {
          $deadline = [DateTime]::UtcNow.AddSeconds(5)
          while ((Get-PortOwnerProcess ([int]$Config.tunnelPort)) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 100
          }
          $started = Start-TunnelService $Config
          if ($started.ok) {
            $tunnelResult = [pscustomobject]@{ action = 'replaced'; pid = $started.pid }
          } else {
            $tunnelResult = [pscustomobject]@{ action = 'faulted'; reason = $started.reason }
          }
        }
      } else {
        $tunnelResult = [pscustomobject]@{ action = 'denied'; pid = [int]$tunnelOwner.ProcessId }
      }
    } else {
      $tunnelResult = [pscustomobject]@{ action = 'denied'; pid = [int]$tunnelOwner.ProcessId }
    }
  }

  return [pscustomobject]@{ status = 'ok'; agentCore = $agentResult; tunnel = $tunnelResult }
}

$script:LifecycleActionInProgress = $false
$script:ShutdownRequested = $false

function Save-ServiceEntry {
  param($Config, [string]$Role, $Entry)
  $path = Get-StatePath $Config
  $state = Read-TrayState $path
  if (-not $state) { $state = New-EmptyTrayState }
  $state.services | Add-Member -NotePropertyName $Role -NotePropertyValue $Entry -Force
  Write-TrayState $path $state
}

function Restart-WatchdogService {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config)
  $probe = Get-ProbeService $Role $Config
  $entry = Get-ServiceStateEntry $Config $Role
  if ($probe.pid -and $entry -and ([int]$entry.pid -eq [int]$probe.pid) -and $probe.identityMatch) {
    Stop-OwnedService $Role $Config | Out-Null
  } else {
    Clear-ServiceStateEntry $Config $Role
  }
  if ($Role -eq 'agentCore') { return Start-AgentCoreService $Config }
  return Start-TunnelService $Config
}

function Get-PrunedRestartHistory {
  param($Entry, $Config)
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $cutoff = $now - ([long]$Config.restartWindowSeconds * 1000)
  $kept = @()
  foreach ($item in @($Entry.restartHistory)) {
    try { $value = [long]$item } catch { continue }
    if ($value -ge $cutoff -and $value -le $now) { $kept += $value }
  }
  return @($kept)
}

function Can-AutoRestart {
  param($Entry, $Config)
  $history = @(Get-PrunedRestartHistory $Entry $Config)
  return ($history.Count -lt [int]$Config.restartLimit)
}

function Record-RestartAttempt {
  param($Config, [string]$Role, $Entry)
  $history = @(Get-PrunedRestartHistory $Entry $Config)
  $history += [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $Entry.restartHistory = @($history)
  Save-ServiceEntry $Config $Role $Entry
  return @($history)
}

function Update-HealthState {
  param($Config, [ValidateSet('agentCore','tunnel')][string]$Role, $Entry, [bool]$Healthy)
  if ($Healthy) {
    $Entry.healthState = 'Running'; $Entry.consecutiveFailures = 0
  } else {
    $Entry.healthState = 'Degraded'; $Entry.consecutiveFailures = [int]$Entry.consecutiveFailures + 1
  }
  Save-ServiceEntry $Config $Role $Entry
  return $Entry
}

function Invoke-WatchdogServiceTick {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config)
  $entry = Get-ServiceStateEntry $Config $Role
  if (-not $entry) { return [pscustomobject]@{ action='unmanaged'; consecutiveFailures=0; healthState='Degraded' } }
  $healthy = if ($Role -eq 'agentCore') { Test-AgentCoreHealth $Config } else { Test-TunnelHealth $Config }
  $entry = Update-HealthState $Config $Role $entry ([bool]$healthy)
  if ($healthy) {
    return [pscustomobject]@{ action='none'; consecutiveFailures=0; healthState='Running' }
  }
  if ([int]$entry.consecutiveFailures -lt [int]$Config.failureThreshold) {
    return [pscustomobject]@{ action='none'; consecutiveFailures=[int]$entry.consecutiveFailures; healthState='Degraded' }
  }
  $entry.restartHistory = @(Get-PrunedRestartHistory $entry $Config)
  if (-not (Can-AutoRestart $entry $Config)) {
    $entry.healthState = 'Faulted'; Save-ServiceEntry $Config $Role $entry
    return [pscustomobject]@{ action='faulted'; consecutiveFailures=[int]$entry.consecutiveFailures; healthState='Faulted' }
  }
  $history = @(Record-RestartAttempt $Config $Role $entry)
  $started = Restart-WatchdogService $Role $Config
  if ($started.ok) {
    $fresh = Get-ServiceStateEntry $Config $Role
    $fresh.restartHistory = @($history); $fresh.consecutiveFailures = 0; $fresh.healthState = 'Running'
    Save-ServiceEntry $Config $Role $fresh
    return [pscustomobject]@{ action='restarted'; consecutiveFailures=0; healthState='Running'; pid=$started.pid }
  }
  return [pscustomobject]@{ action='restart_failed'; consecutiveFailures=[int]$entry.consecutiveFailures; healthState='Degraded' }
}

function Invoke-WatchdogTick {
  param($Config)
  if ($script:LifecycleActionInProgress -or $script:ShutdownRequested) {
    return [pscustomobject]@{ status='suspended' }
  }
  return [pscustomobject]@{
    status = 'ok'
    agentCore = Invoke-WatchdogServiceTick 'agentCore' $Config
    tunnel = Invoke-WatchdogServiceTick 'tunnel' $Config
  }
}

$script:TrayTransitionState = $null

function Get-TrayServiceDisplayStatus {
  param([ValidateSet('agentCore','tunnel')][string]$Role, $Config)
  $entry = Get-ServiceStateEntry $Config $Role
  if ($entry -and $entry.PSObject.Properties['healthState'] -and [string]$entry.healthState -eq 'Faulted') {
    return 'Faulted'
  }
  $probe = Get-ProbeService $Role $Config
  if ($probe.pid -and $entry -and ([int]$entry.pid -eq [int]$probe.pid) -and $probe.identityMatch) {
    if ($probe.healthy) { return 'Running' }
    return 'Degraded'
  }
  return 'Degraded'
}

function Get-OverallTrayStatus {
  param($Config)
  $agentStatus = Get-TrayServiceDisplayStatus 'agentCore' $Config
  $tunnelStatus = Get-TrayServiceDisplayStatus 'tunnel' $Config
  if ($agentStatus -eq 'Faulted' -or $tunnelStatus -eq 'Faulted') { return 'Faulted' }
  if ($agentStatus -eq 'Degraded' -or $tunnelStatus -eq 'Degraded') { return 'Degraded' }
  if ($script:TrayTransitionState) { return [string]$script:TrayTransitionState }
  return 'Running'
}

function Invoke-OAuthReset {
  param($Config)
  $script:LifecycleActionInProgress = $true
  $script:TrayTransitionState = 'Starting'
  try {
    $stopped = Stop-OwnedService 'agentCore' $Config
    $dataDir = Get-AgentCoreDataDir $Config
    $legacyDataDir = Get-LegacyAgentCoreDataDir $Config
    if (-not (Test-Path -LiteralPath $Config.nodeExe)) {
      return [pscustomobject]@{ status='reset_failed'; reason='node_missing'; stopped=$stopped }
    }
    if (-not (Test-Path -LiteralPath $Config.agentCoreCli)) {
      return [pscustomobject]@{ status='reset_failed'; reason='cli_missing'; stopped=$stopped }
    }

    $oldDataDir = [Environment]::GetEnvironmentVariable('AGENT_CORE_DATA_DIR', 'Process')
    [Environment]::SetEnvironmentVariable('AGENT_CORE_DATA_DIR', [string]$dataDir, 'Process')
    try {
      $cliOutput = @(& $Config.nodeExe $Config.agentCoreCli 'reset-oauth' $legacyDataDir 2>&1)
      $cliExit = $LASTEXITCODE
    } finally {
      [Environment]::SetEnvironmentVariable('AGENT_CORE_DATA_DIR', $oldDataDir, 'Process')
    }

    if ($cliExit -ne 0) {
      $agent = Start-AgentCoreService $Config
      return [pscustomobject]@{
        status='reset_failed'; reason='cli_failed'; exitCode=$cliExit
        agentCore=$agent; stopped=$stopped
      }
    }
    try {
      $oauthReset = ($cliOutput -join [Environment]::NewLine) | ConvertFrom-Json
    } catch {
      $agent = Start-AgentCoreService $Config
      return [pscustomobject]@{
        status='reset_failed'; reason='invalid_cli_output'; agentCore=$agent; stopped=$stopped
      }
    }
    $agent = Start-AgentCoreService $Config
    $status = if ($agent.ok) { 'ready_for_reauth' } else { 'degraded' }
    return [pscustomobject]@{
      status=$status; oauthReset=$oauthReset; agentCore=$agent; stopped=$stopped
    }
  } finally {
    $script:TrayTransitionState = $null
    $script:LifecycleActionInProgress = $false
  }
}

function Invoke-ManualRestart {
  param([ValidateSet('agentCore','tunnel','all')][string]$Service, $Config)
  $script:LifecycleActionInProgress = $true
  $script:TrayTransitionState = 'Starting'
  try {
    if ($Service -eq 'all') {
      Stop-Bundle $Config | Out-Null
      return Start-Bundle $Config
    }
    Stop-OwnedService $Service $Config | Out-Null
    if ($Service -eq 'agentCore') { return Start-AgentCoreService $Config }
    return Start-TunnelService $Config
  } finally {
    $script:TrayTransitionState = $null
    $script:LifecycleActionInProgress = $false
  }
}

function Invoke-TrayExit {
  param($Config, $WatchdogTimer = $null, $NotifyIcon = $null, [switch]$Diagnostic)
  $script:ShutdownRequested = $true
  $script:LifecycleActionInProgress = $true
  $script:TrayTransitionState = 'Stopping'
  if ($WatchdogTimer) {
    try { $WatchdogTimer.Stop() } catch {}
  }
  $result = Stop-Bundle $Config
  if ($NotifyIcon) {
    try { $NotifyIcon.Visible = $false } catch {}
    try { $NotifyIcon.Dispose() } catch {}
  }
  if (-not $Diagnostic) {
    try { [System.Windows.Forms.Application]::ExitThread() } catch {}
  }
  return [pscustomobject]@{
    status = 'exited'
    watchdogSuspended = $true
    agentCore = $result.agentCore
    tunnel = $result.tunnel
  }
}

function Get-AgentCoreAutostartEnabled {
  param($Config)
  try {
    $task = Get-ScheduledTask -TaskName 'Agent Core Tray Manager' -ErrorAction Stop
    if (-not $task -or @($task.Actions).Count -ne 1) { return $false }
    $action = @($task.Actions)[0]
    $localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
    if (-not $localAppData) { $localAppData = [Environment]::GetFolderPath('LocalApplicationData') }
    $expectedLauncher = Join-Path (Join-Path $localAppData 'AgentCore') 'launch-current.ps1'
    if (-not [string]::Equals([string]$action.Execute, 'powershell.exe', [StringComparison]::OrdinalIgnoreCase)) { return $false }
    return ([string]$action.Arguments).IndexOf($expectedLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0
  } catch {
    return $false
  }
}
function Invoke-AgentCoreAutostartToggle {
  param($Config)
  $enabled = Get-AgentCoreAutostartEnabled $Config
  $helper = if ($enabled) {
    Join-Path $script:ScriptDir 'uninstall-agent-core-autostart.ps1'
  } else {
    Join-Path $script:ScriptDir 'install-agent-core-autostart.ps1'
  }
  if (-not (Test-Path -LiteralPath $helper)) { return $false }
  $arguments = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $helper + '"'))
  $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  return ($process.ExitCode -eq 0)
}

function Refresh-TrayStatus {
  param($Config, $OverallItem, $AgentItem, $TunnelItem, $NotifyIcon, $AutostartItem)
  $agentStatus = Get-TrayServiceDisplayStatus 'agentCore' $Config
  $tunnelStatus = Get-TrayServiceDisplayStatus 'tunnel' $Config
  $overallStatus = Get-OverallTrayStatus $Config
  $OverallItem.Text = ('Agent Core ' + [char]0x2014 + ' ' + $overallStatus)
  $AgentItem.Text = "MCP Server: $agentStatus"
  $TunnelItem.Text = "Tunnel: $tunnelStatus"
  $AutostartItem.Text = 'Start with Windows: ' + $(if (Get-AgentCoreAutostartEnabled $Config) { 'On' } else { 'Off' })
  $NotifyIcon.Text = "Agent Core - $overallStatus"
}

function Start-AgentCoreTray {
  param($Config)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  Start-Bundle $Config | Out-Null

  $notifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
  $menu = New-Object System.Windows.Forms.ContextMenuStrip

  $overallItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $overallItem.Enabled = $false
  $agentItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $agentItem.Enabled = $false
  $tunnelItem = New-Object System.Windows.Forms.ToolStripMenuItem
  $tunnelItem.Enabled = $false
  [void]$menu.Items.Add($overallItem)
  [void]$menu.Items.Add($agentItem)
  [void]$menu.Items.Add($tunnelItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $openFolder = New-Object System.Windows.Forms.ToolStripMenuItem 'Open Agent Core Folder'
  $openAdmin = New-Object System.Windows.Forms.ToolStripMenuItem 'Open Tunnel Admin UI'
  [void]$menu.Items.Add($openFolder)
  [void]$menu.Items.Add($openAdmin)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $restartAgent = New-Object System.Windows.Forms.ToolStripMenuItem 'Restart Agent Core'
  $restartTunnel = New-Object System.Windows.Forms.ToolStripMenuItem 'Restart Tunnel'
  $restartAll = New-Object System.Windows.Forms.ToolStripMenuItem 'Restart All'
  $resetOAuth = New-Object System.Windows.Forms.ToolStripMenuItem 'Reset OAuth / Re-auth'
  [void]$menu.Items.Add($restartAgent)
  [void]$menu.Items.Add($restartTunnel)
  [void]$menu.Items.Add($restartAll)
  [void]$menu.Items.Add($resetOAuth)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $autostartItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Start with Windows: Off'
  [void]$menu.Items.Add($autostartItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit Agent Core'
  [void]$menu.Items.Add($exitItem)

  $notifyIcon.ContextMenuStrip = $menu
  $notifyIcon.Visible = $true

  $watchdogTimer = New-Object System.Windows.Forms.Timer
  $watchdogTimer.Interval = [Math]::Max(1000, ([int]$Config.watchdogIntervalSeconds * 1000))
  $exitRequestPath = Join-Path ([string]$Config.trayRuntimeDir) 'exit.request'

  $openFolder.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList @([string]$Config.root) | Out-Null })
  $openAdmin.Add_Click({ Start-Process ("http://127.0.0.1:{0}/ui" -f [int]$Config.tunnelPort) | Out-Null })
  $restartAgent.Add_Click({ Invoke-ManualRestart -Service 'agentCore' -Config $Config | Out-Null; Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem })
  $restartTunnel.Add_Click({ Invoke-ManualRestart -Service 'tunnel' -Config $Config | Out-Null; Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem })
  $restartAll.Add_Click({ Invoke-ManualRestart -Service 'all' -Config $Config | Out-Null; Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem })
  $resetOAuth.Add_Click({
    $choice = [System.Windows.Forms.MessageBox]::Show(
      'Reset OAuth sessions and prepare Agent Core for re-authentication? Custom Agent Core API keys are preserved.',
      'Agent Core OAuth Reset',
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    )
    if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) {
      $result = Invoke-OAuthReset $Config
      Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem
      $message = if ($result.status -eq 'ready_for_reauth') {
        'OAuth state reset complete. Custom Agent Core API keys were preserved. Reconnect Agent Core in ChatGPT and authorize with your registered custom key.'
      } else {
        'OAuth reset did not complete cleanly. Check the Agent Core tray logs.'
      }
      [void][System.Windows.Forms.MessageBox]::Show($message, 'Agent Core OAuth Reset')
    }
  })
  $autostartItem.Add_Click({ Invoke-AgentCoreAutostartToggle $Config | Out-Null; Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem })
  $exitItem.Add_Click({ Invoke-TrayExit -Config $Config -WatchdogTimer $watchdogTimer -NotifyIcon $notifyIcon | Out-Null })
  $watchdogTimer.Add_Tick({
    if (Test-Path -LiteralPath $exitRequestPath) {
      try { [IO.File]::Delete($exitRequestPath) } catch {}
      Invoke-TrayExit -Config $Config -WatchdogTimer $watchdogTimer -NotifyIcon $notifyIcon | Out-Null
      return
    }
    Invoke-WatchdogTick $Config | Out-Null
    Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem
  })

  Refresh-TrayStatus $Config $overallItem $agentItem $tunnelItem $notifyIcon $autostartItem
  $watchdogTimer.Start()
  try {
    [System.Windows.Forms.Application]::Run()
  } finally {
    try { $watchdogTimer.Stop(); $watchdogTimer.Dispose() } catch {}
    try { $notifyIcon.Visible = $false; $notifyIcon.Dispose() } catch {}
    try { $menu.Dispose() } catch {}
  }
}

$config = Get-AgentCoreTrayConfig $ConfigPath
$mutexHandle = Acquire-TrayMutex $config
if (-not $mutexHandle.Acquired) {
  Write-Output (([ordered]@{ status = 'already_running' }) | ConvertTo-Json -Compress)
  Release-TrayMutex $mutexHandle
  exit 23
}

try {
  switch ($Mode) {
    'Probe' { Invoke-Probe $config; break }
    'StartBundle' { Write-Output ((Start-Bundle $config) | ConvertTo-Json -Depth 8 -Compress); break }
    'StopBundle' { Write-Output ((Stop-Bundle $config) | ConvertTo-Json -Depth 8 -Compress); break }
    'RestartBundle' {
      Stop-Bundle $config | Out-Null
      Write-Output ((Start-Bundle $config) | ConvertTo-Json -Depth 8 -Compress)
      break
    }
    'ResetOAuth' {
      Write-Output ((Invoke-OAuthReset $config) | ConvertTo-Json -Depth 8 -Compress)
      break
    }
    'ControlledTakeover' {
      Write-Output ((Invoke-ControlledTakeover $config) | ConvertTo-Json -Depth 8 -Compress)
      break
    }
    'WatchdogTick' {
      Write-Output ((Invoke-WatchdogTick $config) | ConvertTo-Json -Depth 8 -Compress)
      break
    }
    'TrayExit' {
      Write-Output ((Invoke-TrayExit -Config $config -Diagnostic) | ConvertTo-Json -Depth 8 -Compress)
      break
    }
    'Tray' {
      Start-AgentCoreTray $config
      break
    }
    default {
      Write-Output (([ordered]@{ status = 'not_implemented'; mode = $Mode }) | ConvertTo-Json -Compress)
      exit 2
    }
  }
} finally {
  Release-TrayMutex $mutexHandle
}


