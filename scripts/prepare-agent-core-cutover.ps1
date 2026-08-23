param(
  [Parameter(Mandatory = $true)][string]$SourceRoot,
  [Parameter(Mandatory = $true)][string]$BackupRoot,
  [string]$TunnelProfile = '',
  [string]$TunnelId = '',
  [int]$ProcessPid = 0,
  [int]$Port = 8765
)
$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$backupBase = [IO.Path]::GetFullPath($BackupRoot).TrimEnd('\')
if ($backupBase.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'BackupRoot must be outside SourceRoot'
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backupDir = Join-Path $backupBase "agent-core-cutover-$stamp"
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$copied = New-Object System.Collections.Generic.List[string]

function Copy-OwnedPath([string]$relativePath) {
  $from = Join-Path $source $relativePath
  if (-not (Test-Path -LiteralPath $from)) { return }
  $to = Join-Path $backupDir $relativePath
  $parent = Split-Path -Parent $to
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
  $copied.Add($relativePath.Replace('\', '/')) | Out-Null
}
Copy-OwnedPath 'runtime\data'
Copy-OwnedPath 'secrets'
Copy-OwnedPath 'capabilities\registry'
Copy-OwnedPath 'capabilities\provenance'
Copy-OwnedPath 'capabilities\normalized'

if ($TunnelProfile -and (Test-Path -LiteralPath $TunnelProfile)) {
  $tunnelTarget = Join-Path $backupDir 'tunnel-profile.yaml'
  Copy-Item -LiteralPath $TunnelProfile -Destination $tunnelTarget -Force
  $copied.Add('tunnel-profile.yaml') | Out-Null
}

function Get-GitValue([string[]]$Args) {
  try {
    $value = & git -C $source @Args 2>$null
    if ($LASTEXITCODE -eq 0) { return ($value | Select-Object -First 1) }
  } catch {}
  return $null
}

$manifest = [ordered]@{
  version = 1
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  sourceRoot = $source
  mainSha = Get-GitValue @('rev-parse', 'HEAD')
  originUrl = Get-GitValue @('remote', 'get-url', 'origin')
  tunnelId = $(if ($TunnelId) { $TunnelId } else { $null })
  processPid = $(if ($ProcessPid -gt 0) { $ProcessPid } else { $null })
  port = $Port
  copiedPaths = @($copied)
}
$manifestPath = Join-Path $backupDir 'migration-manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
Write-Output $backupDir
