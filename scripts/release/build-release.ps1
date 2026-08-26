param(
  [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid stable semver: $version" }
$tag = "v$version"

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path $root 'release'
} elseif (-not [System.IO.Path]::IsPathRooted($OutputRoot)) {
  $OutputRoot = Join-Path $root $OutputRoot
}

$releaseRoot = Join-Path $OutputRoot $tag
$assetsDir = Join-Path $releaseRoot 'assets'
$stagingDir = Join-Path $releaseRoot 'staging'
$runtimeStage = Join-Path $stagingDir 'Agent-Core'
$pluginStage = Join-Path $stagingDir 'agent-core-plugin'

if (Test-Path $releaseRoot) { Remove-Item $releaseRoot -Recurse -Force }
New-Item -ItemType Directory -Force $assetsDir,$runtimeStage,$pluginStage | Out-Null

function Copy-Path {
  param([string]$RelativeSource,[string]$RelativeDestination='')
  $source = Join-Path $root $RelativeSource
  if (-not (Test-Path $source)) { throw "Release source missing: $RelativeSource" }
  $destinationRelative = if ([string]::IsNullOrWhiteSpace($RelativeDestination)) { $RelativeSource } else { $RelativeDestination }
  $destination = Join-Path $runtimeStage $destinationRelative
  $parent = Split-Path -Parent $destination
  if ($parent) { New-Item -ItemType Directory -Force $parent | Out-Null }
  if ((Get-Item $source).PSIsContainer) {
    Copy-Item $source $destination -Recurse -Force
  } else {
    Copy-Item $source $destination -Force
  }
}

# Runtime/source distribution: explicit allowlist only.
$runtimeFiles = @(
  '.env.example',
  'README.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'Start-Agent-Core.bat',
  'src',
  'dist',
  'scripts',
  'plugin\agent-core\README.md',
  'plugin\agent-core\skills',
  'docs\README.md',
  'docs\deterministic-memory.md',
  'docs\local-agent-continuity.md',
  'docs\deterministic-execution-fabric.md',
  'docs\multi-command-wake-workflow.md',
  'docs\github.md',
  'docs\stability.md',
  'docs\roadmap',
  'docs\diagrams',
  'tunnel-client\agent-core.example.yaml'
)
foreach ($item in $runtimeFiles) { Copy-Path $item }

# Reproducible tracked-core plugin package. Local generated capabilities are intentionally excluded.
New-Item -ItemType Directory -Force (Join-Path $pluginStage 'skills\agent-core-capability-router'),(Join-Path $pluginStage 'skills\agent-core-github') | Out-Null
Copy-Item (Join-Path $root 'plugin\agent-core\README.md') (Join-Path $pluginStage 'README.md') -Force
Copy-Item (Join-Path $root 'plugin\agent-core\skills\agent-core-capability-router\SKILL.md') (Join-Path $pluginStage 'skills\agent-core-capability-router\SKILL.md') -Force
Copy-Item (Join-Path $root 'plugin\agent-core\skills\agent-core-github\SKILL.md') (Join-Path $pluginStage 'skills\agent-core-github\SKILL.md') -Force
Copy-Item (Join-Path $root 'CHANGELOG.md') (Join-Path $pluginStage 'CHANGELOG.md') -Force

$pluginMetadata = [ordered]@{
  format = 'agent-core-plugin-source-v1'
  name = 'Agent Core'
  version = $version
  channel = 'stable'
  description = 'Tracked Agent Core Capability Router and Native GitHub Fabric skills plus the existing Agent Core MCP app binding.'
  app = [ordered]@{
    name = 'Agent Core'
    protocol = 'mcp'
    endpoint = '/mcp'
    binding = 'existing-connected-chatgpt-app'
    discovery = 'tools/list'
  }
  skills = @('agent-core-capability-router','agent-core-github')
  generatedFrom = [ordered]@{
    source = 'tracked-release-core'
    localAuditedRegistryVendored = $false
  }
}
$pluginMetadata | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $pluginStage 'agent-core-package.json') -Encoding utf8

$npmPackage = [ordered]@{
  name = '@rendevouz999/agent-core-plugin'
  version = $version
  description = 'Stable Agent Core routing and Native GitHub Fabric plugin source for the Agent Core MCP app.'
  private = $false
  license = 'UNLICENSED'
  files = @('README.md','CHANGELOG.md','agent-core-package.json','skills/**')
  repository = [ordered]@{
    type = 'git'
    url = 'git+https://github.com/rendevouz999/Agent-Core.git'
  }
  publishConfig = [ordered]@{
    registry = 'https://npm.pkg.github.com'
  }
}
$npmPackage | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $pluginStage 'package.json') -Encoding utf8

$runtimeZip = Join-Path $assetsDir "agent-core-windows-$tag-stable.zip"
$pluginZip = Join-Path $assetsDir "agent-core-plugin-$tag-stable.zip"
Compress-Archive -Path $runtimeStage -DestinationPath $runtimeZip -CompressionLevel Optimal
Compress-Archive -Path $pluginStage -DestinationPath $pluginZip -CompressionLevel Optimal

Push-Location $pluginStage
try {
  & npm pack --pack-destination $assetsDir | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "npm pack failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$sourceCommit = (& git -C $root rev-parse HEAD).Trim()
$assetFiles = Get-ChildItem $assetsDir -File | Sort-Object Name
$hashLines = New-Object System.Collections.Generic.List[string]
$manifestAssets = @()
foreach ($asset in $assetFiles) {
  $hash = (Get-FileHash $asset.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashLines.Add("$hash  $($asset.Name)")
  $manifestAssets += [ordered]@{
    name = $asset.Name
    bytes = $asset.Length
    sha256 = $hash
  }
}
$hashPath = Join-Path $assetsDir 'SHA256SUMS.txt'
$hashLines | Set-Content $hashPath -Encoding ascii

$manifest = [ordered]@{
  format = 'agent-core-stable-release-v1'
  version = $version
  tag = $tag
  channel = 'stable'
  sourceCommit = $sourceCommit
  runtimePackage = "agent-core-windows-$tag-stable.zip"
  pluginPackage = "agent-core-plugin-$tag-stable.zip"
  githubPackage = '@rendevouz999/agent-core-plugin'
  packageDistTag = 'stable'
  exclusions = @('secrets','runtime','data','logs','capabilities','node_modules','.env','local tunnel credentials','raw execution evidence')
  assets = $manifestAssets
}
$manifestPath = Join-Path $assetsDir 'release-manifest.json'
$manifest | ConvertTo-Json -Depth 10 | Set-Content $manifestPath -Encoding utf8

# Include checksums for the manifest itself after it exists, without recursively hashing SHA256SUMS.
$manifestHash = (Get-FileHash $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Content $hashPath "$manifestHash  release-manifest.json" -Encoding ascii

Write-Output (ConvertTo-Json ([ordered]@{
  ok = $true
  version = $version
  tag = $tag
  releaseRoot = $releaseRoot
  assetsDir = $assetsDir
  pluginPublishDir = $pluginStage
  assets = (Get-ChildItem $assetsDir -File | Sort-Object Name | ForEach-Object { $_.Name })
}) -Depth 6)
