[CmdletBinding()]
param(
  [switch]$StartNow,
  [switch]$ControlledTakeover,
  [switch]$ContractOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = [IO.Path]::GetFullPath((Join-Path $scriptDir '..\\..'))
$trayScript = Join-Path $scriptDir 'agent-core-tray.ps1'
$launcherScript = Join-Path $scriptDir 'agent-core-launcher.ps1'
$taskName = 'Agent Core Tray Manager'
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$localAppData = [Environment]::GetEnvironmentVariable('LOCALAPPDATA', 'Process')
if (-not $localAppData) { $localAppData = [Environment]::GetFolderPath('LocalApplicationData') }
$locatorDir = Join-Path $localAppData 'AgentCore'
$locatorRootFile = Join-Path $locatorDir 'root.txt'
$locatorScript = Join-Path $locatorDir 'launch-current.ps1'
$actionArguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $locatorScript + '"'

$contract = [ordered]@{
  taskName = $taskName
  executable = 'powershell.exe'
  arguments = $actionArguments
  locatorRootFile = $locatorRootFile
  trigger = 'AtLogOn'
  logonType = 'Interactive'
  runLevel = 'Limited'
}
if ($ContractOnly) {
  Write-Output ($contract | ConvertTo-Json -Compress)
  exit 0
}

foreach ($required in @($trayScript, $launcherScript)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required Agent Core file not found: $required" }
}

New-Item -ItemType Directory -Path $locatorDir -Force | Out-Null
[IO.File]::WriteAllText($locatorRootFile, $root, (New-Object Text.UTF8Encoding($false)))
$shimLines = @(
  'Set-StrictMode -Version Latest',
  '$ErrorActionPreference = ''Stop''',
  '$stateDir = Split-Path -Parent $MyInvocation.MyCommand.Path',
  '$rootFile = Join-Path $stateDir ''root.txt''',
  'if (-not (Test-Path -LiteralPath $rootFile)) { exit 2 }',
  '$root = [IO.File]::ReadAllText($rootFile).Trim()',
  '$launcher = Join-Path $root ''scripts\\windows\\agent-core-launcher.ps1''',
  'if (-not (Test-Path -LiteralPath $launcher)) { exit 3 }',
  '& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $launcher -Autostart',
  'exit $LASTEXITCODE'
)
$shim = $shimLines -join [Environment]::NewLine
[IO.File]::WriteAllText($locatorScript, $shim, (New-Object Text.UTF8Encoding($false)))

if ($ControlledTakeover) {
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $trayScript -Mode ControlledTakeover | Out-Null
  $takeoverExit = $LASTEXITCODE
  if ($takeoverExit -ne 0 -and $takeoverExit -ne 23) { throw "Controlled takeover failed with exit code $takeoverExit" }
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $actionArguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

if ($StartNow) {
  $launchArgs = @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $launcherScript + '"'))
  Start-Process -FilePath 'powershell.exe' -ArgumentList $launchArgs -WindowStyle Hidden | Out-Null
}
