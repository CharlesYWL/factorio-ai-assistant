<#
.SYNOPSIS
Installs the Factorio AI Assistant Mod and Companion, then starts the Companion.

.DESCRIPTION
Downloads a release from GitHub, copies the Mod zip into the Factorio mods
folder, unpacks the Companion, and launches it.

Reinstalling is safe: your `companion.config.json` is never overwritten, and if
a previous install lives in a differently-versioned folder its config is
carried across. Everything else in the Companion folder is replaced.

.PARAMETER Tag
Release tag to install, for example `v0.1.0-rc.6`. Defaults to the latest
release.

.PARAMETER FromLocalBuild
Install from `release/<tag>/` in this repository instead of downloading. Useful
while developing.

.PARAMETER NoStart
Install without starting the Companion.

.EXAMPLE
.\install.ps1

.EXAMPLE
.\install.ps1 -Tag v0.1.0-rc.6
#>
[CmdletBinding()]
param(
  [string]$Tag,
  [switch]$FromLocalBuild,
  [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repository = "CharlesYWL/factorio-ai-assistant"
$ModName = "factorio-ai-assistant"
$InstallRoot = Join-Path $env:LOCALAPPDATA "FactorioAI Assistant"
$ConfigName = "companion.config.json"

function Write-Step {
  param([string]$Message)
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
  param([string]$Message)
  Write-Host "    $Message" -ForegroundColor DarkGray
}

function Get-FactorioModsDirectory {
  $candidates = @(
    (Join-Path $env:APPDATA "Factorio\mods"),
    (Join-Path $env:USERPROFILE "Factorio\mods")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return $candidate
    }
  }
  throw "Factorio mods folder not found. Looked in: $($candidates -join ', '). Start Factorio once, then run this again."
}

function Resolve-ReleaseTag {
  if ($Tag) {
    return $Tag
  }
  Write-Note "Looking up the latest release..."
  $uri = "https://api.github.com/repos/$Repository/releases/latest"
  try {
    $release = Invoke-RestMethod -Uri $uri -Headers @{ "User-Agent" = "factorio-ai-assistant-installer" }
  } catch {
    throw "Could not reach GitHub to find the latest release. Pass -Tag to install a specific one. ($($_.Exception.Message))"
  }
  return $release.tag_name
}

function Get-ReleaseFiles {
  param([string]$ReleaseTag, [string]$Destination)

  if ($FromLocalBuild) {
    $local = Join-Path $PSScriptRoot "release\$ReleaseTag"
    if (-not (Test-Path -LiteralPath $local)) {
      throw "No local build at $local. Run 'npm run package' first, or drop -FromLocalBuild."
    }
    Write-Note "Using local build at $local"
    return $local
  }

  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  foreach ($asset in @(
      "$ModName`_0.1.0.zip",
      "factorio-ai-assistant-companion-windows-x64-0.1.0.zip"
    )) {
    $url = "https://github.com/$Repository/releases/download/$ReleaseTag/$asset"
    Write-Note "Downloading $asset"
    try {
      Invoke-WebRequest -Uri $url -OutFile (Join-Path $Destination $asset) -UseBasicParsing
    } catch {
      throw "Could not download $asset from $ReleaseTag. ($($_.Exception.Message))"
    }
  }
  return $Destination
}

function Install-Mod {
  param([string]$SourceDirectory, [string]$ModsDirectory)

  $zip = Get-ChildItem -LiteralPath $SourceDirectory -Filter "$ModName`_*.zip" |
    Select-Object -First 1
  if (-not $zip) {
    throw "No Mod zip found in $SourceDirectory"
  }

  # A dev junction from `npm run dev:link` would shadow the installed zip, so
  # say something rather than leaving the player with two versions in play.
  $linkPath = Join-Path $ModsDirectory ([System.IO.Path]::GetFileNameWithoutExtension($zip.Name))
  if (Test-Path -LiteralPath $linkPath) {
    $item = Get-Item -LiteralPath $linkPath -Force
    if ($item.LinkType) {
      Write-Warning "A development link is present at $linkPath and Factorio will load it instead of this install. Run 'npm run dev:unlink' to use the released Mod."
    }
  }

  # Older versions leave their own zip behind, and Factorio would load both.
  Get-ChildItem -LiteralPath $ModsDirectory -Filter "$ModName`_*.zip" |
    Where-Object { $_.Name -ne $zip.Name } |
    ForEach-Object {
      Write-Note "Removing older Mod $($_.Name)"
      Remove-Item -LiteralPath $_.FullName -Force
    }

  Copy-Item -LiteralPath $zip.FullName -Destination $ModsDirectory -Force
  Write-Note "Installed $($zip.Name)"
}

function Get-PreviousConfig {
  param([string]$TargetDirectory)

  $current = Join-Path $TargetDirectory $ConfigName
  if (Test-Path -LiteralPath $current) {
    return $current
  }

  # An upgrade that changes the version number lands in a new folder; carry the
  # previous config across so settings and API keys are not silently lost.
  if (-not (Test-Path -LiteralPath $InstallRoot)) {
    return $null
  }
  $previous = Get-ChildItem -LiteralPath $InstallRoot -Directory |
    Where-Object { $_.FullName -ne $TargetDirectory } |
    ForEach-Object { Join-Path $_.FullName $ConfigName } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } -Descending |
    Select-Object -First 1
  return $previous
}

function Install-Companion {
  param([string]$SourceDirectory)

  $zip = Get-ChildItem -LiteralPath $SourceDirectory -Filter "factorio-ai-assistant-companion-*.zip" |
    Select-Object -First 1
  if (-not $zip) {
    throw "No Companion zip found in $SourceDirectory"
  }

  $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("faa-companion-" + [Guid]::NewGuid().ToString("N"))
  Expand-Archive -LiteralPath $zip.FullName -DestinationPath $staging -Force

  $unpacked = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
  if (-not $unpacked) {
    throw "The Companion archive did not contain the expected folder"
  }

  $target = Join-Path $InstallRoot $unpacked.Name
  $existingConfig = Get-PreviousConfig -TargetDirectory $target
  $savedConfig = $null
  if ($existingConfig) {
    $savedConfig = Join-Path $staging "preserved.config.json"
    Copy-Item -LiteralPath $existingConfig -Destination $savedConfig -Force
  }

  # Logs are the player's, not ours; keep them across reinstalls.
  $existingLogs = Join-Path $target "logs"
  $savedLogs = $null
  if (Test-Path -LiteralPath $existingLogs) {
    $savedLogs = Join-Path $staging "preserved-logs"
    Copy-Item -LiteralPath $existingLogs -Destination $savedLogs -Recurse -Force
  }

  if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  Move-Item -LiteralPath $unpacked.FullName -Destination $target

  $configPath = Join-Path $target $ConfigName
  if ($savedConfig) {
    Copy-Item -LiteralPath $savedConfig -Destination $configPath -Force
    if ($existingConfig -ne $configPath) {
      Write-Note "Carried your settings over from $existingConfig"
    } else {
      Write-Note "Kept your existing $ConfigName"
    }
  } else {
    $example = Join-Path $target "companion.config.example.json"
    if (Test-Path -LiteralPath $example) {
      Copy-Item -LiteralPath $example -Destination $configPath
      Write-Note "Created $ConfigName from the example; edit it to add your model settings"
    }
  }

  if ($savedLogs) {
    Copy-Item -LiteralPath $savedLogs -Destination (Join-Path $target "logs") -Recurse -Force
  }

  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  return $target
}

function Assert-Node {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    throw "Node.js was not found on PATH. Install Node.js 22 or newer from https://nodejs.org and run this again."
  }
  $version = (& $node.Source --version).TrimStart("v")
  if ([int]($version.Split(".")[0]) -lt 22) {
    throw "Node.js 22 or newer is required; found $version."
  }
  Write-Note "Node.js $version"
}

Write-Step "Checking prerequisites"
Assert-Node
$modsDirectory = Get-FactorioModsDirectory
Write-Note "Factorio mods: $modsDirectory"

$releaseTag = if ($FromLocalBuild -and -not $Tag) {
  $configPath = Join-Path $PSScriptRoot "release.config.json"
  if (Test-Path -LiteralPath $configPath) {
    (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).release_tag
  } else {
    throw "Pass -Tag when using -FromLocalBuild outside the repository."
  }
} else {
  Resolve-ReleaseTag
}
Write-Step "Installing $releaseTag"

$download = Join-Path ([System.IO.Path]::GetTempPath()) ("faa-release-" + [Guid]::NewGuid().ToString("N"))
try {
  $source = Get-ReleaseFiles -ReleaseTag $releaseTag -Destination $download

  Write-Step "Installing the Mod"
  Install-Mod -SourceDirectory $source -ModsDirectory $modsDirectory

  Write-Step "Installing the Companion"
  $companion = Install-Companion -SourceDirectory $source
  Write-Note $companion
} finally {
  if (Test-Path -LiteralPath $download) {
    Remove-Item -LiteralPath $download -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "Installed." -ForegroundColor Green
Write-Host "Add this to Factorio's Steam launch options if you have not already:" -ForegroundColor Yellow
Write-Host "    --enable-lua-udp=34198" -ForegroundColor Yellow
Write-Host ""

if ($NoStart) {
  Write-Note "Start the Companion later with: $(Join-Path $companion 'start-companion.cmd')"
  return
}

Write-Step "Starting the Companion"
Start-Process -FilePath (Join-Path $companion "start-companion.cmd") -WorkingDirectory $companion
Write-Note "Running in a separate window. Close that window to stop it."
