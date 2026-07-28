[CmdletBinding()]
param(
  [string]$OutputDirectory = (Join-Path $PSScriptRoot "diagnostics")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$Notes = New-Object System.Collections.Generic.List[string]

$CompanionLog = Join-Path $PSScriptRoot "logs\companion-current.log"
if (Test-Path -LiteralPath $CompanionLog) {
  Copy-Item -LiteralPath $CompanionLog -Destination $OutputDirectory -Force
} else {
  $Notes.Add("Companion log was not found at $CompanionLog")
}

$FactorioLog = Join-Path $env:APPDATA "Factorio\factorio-current.log"
if (Test-Path -LiteralPath $FactorioLog) {
  Copy-Item -LiteralPath $FactorioLog -Destination $OutputDirectory -Force
} else {
  $Notes.Add("Factorio log was not found at $FactorioLog")
}

$ConfigPath = Join-Path $PSScriptRoot "companion.config.json"
if (Test-Path -LiteralPath $ConfigPath) {
  $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
  if ($null -ne $Config.PSObject.Properties["api_key"]) {
    $Config.api_key = "[REDACTED]"
  }
  $Config |
    ConvertTo-Json -Depth 10 |
    Set-Content -LiteralPath (Join-Path $OutputDirectory "companion.config.redacted.json") -Encoding UTF8
}

$NodeVersion = try {
  $Value = (& node --version).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "node --version failed"
  }
  $Value
} catch {
  "not found"
}
$CompanionVersion = try {
  $Value = (& node (Join-Path $PSScriptRoot "companion.mjs") --version).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "companion --version failed"
  }
  $Value
} catch {
  "not found"
}
@(
  "collected_at_utc=$([DateTime]::UtcNow.ToString('o'))"
  "windows_version=$([Environment]::OSVersion.VersionString)"
  "node_version=$NodeVersion"
  "companion_version=$CompanionVersion"
) | Set-Content -LiteralPath (Join-Path $OutputDirectory "environment.txt") -Encoding UTF8

if ($Notes.Count -gt 0) {
  $Notes | Set-Content -LiteralPath (Join-Path $OutputDirectory "MISSING.txt") -Encoding UTF8
}

$ArchivePath = "$OutputDirectory.zip"
Compress-Archive -Path (Join-Path $OutputDirectory "*") -DestinationPath $ArchivePath -Force
Write-Host "Diagnostics written to $ArchivePath"
Write-Host "Review the archive for local paths before sharing it."
