[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Get-Command node -ErrorAction Stop
$NodeVersion = (& $Node.Source --version).TrimStart("v")
if ($LASTEXITCODE -ne 0) {
  throw "Unable to read the Node.js version."
}
$NodeMajor = [int]($NodeVersion.Split(".")[0])
if ($NodeMajor -lt 22) {
  throw "Node.js 22 or newer is required; found $NodeVersion."
}

$ConfigPath = Join-Path $Root "companion.config.json"
if (Test-Path -LiteralPath $ConfigPath) {
  $env:FACTORIO_ASSISTANT_CONFIG = $ConfigPath
}

$LogDirectory = Join-Path $Root "logs"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory "companion-current.log"

Write-Host "Starting Factorio AI Assistant Companion $(& $Node.Source (Join-Path $Root 'companion.mjs') --version)"
Write-Host "Log: $LogPath"
& $Node.Source (Join-Path $Root "companion.mjs") 2>&1 |
  Tee-Object -FilePath $LogPath
$ExitCode = $LASTEXITCODE
exit $ExitCode
