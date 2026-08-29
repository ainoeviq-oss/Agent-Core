param(
  [string]$OutputRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$builder = Join-Path $scriptDir 'build-release.mjs'
$arguments = @($builder)
if (-not [string]::IsNullOrWhiteSpace($OutputRoot)) {
  $arguments += @('--output-root', $OutputRoot)
}

& node @arguments
if ($LASTEXITCODE -ne 0) {
  throw "Agent Core release builder failed with exit code $LASTEXITCODE"
}
