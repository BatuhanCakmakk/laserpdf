# Packs the release build into an unsigned MSIX for Microsoft Store upload.
# The Store signs the package after certification, so no certificate is needed here.
#
# Usage (after `npx tauri build --no-bundle`):
#   ./scripts/pack-msix.ps1 -IdentityName <name> -Publisher "CN=..." -PublisherDisplayName <name>
# The three values are shown in Partner Center under Product management -> Product identity.
param(
  [string]$IdentityName = $(if ($env:MSIX_IDENTITY_NAME) { $env:MSIX_IDENTITY_NAME } else { "LaserPDF.Dev" }),
  [string]$Publisher = $(if ($env:MSIX_PUBLISHER) { $env:MSIX_PUBLISHER } else { "CN=00000000-0000-0000-0000-000000000000" }),
  [string]$PublisherDisplayName = $(if ($env:MSIX_PUBLISHER_DISPLAY_NAME) { $env:MSIX_PUBLISHER_DISPLAY_NAME } else { "Batuhan Cakmak" })
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tauri = Join-Path $root "src-tauri"

# The Store requires a four-part version whose last part is 0.
$version = (Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json).version
$msixVersion = "$version.0"

$exe = Join-Path $tauri "target\release\laserpdf.exe"
if (-not (Test-Path $exe)) { throw "Missing $exe. Run 'npx tauri build --no-bundle' first." }

$layout = Join-Path $tauri "target\msix\layout"
$outDir = Join-Path $tauri "target\msix"
if (Test-Path $layout) { Remove-Item -Recurse -Force $layout }
New-Item -ItemType Directory -Force (Join-Path $layout "Assets") | Out-Null

Copy-Item $exe (Join-Path $layout "LaserPDF.exe")
foreach ($icon in "StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png") {
  Copy-Item (Join-Path $tauri "icons\$icon") (Join-Path $layout "Assets\$icon")
}

# XML-escape values before substituting them into the manifest.
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$manifest = (Get-Content (Join-Path $tauri "msix\AppxManifest.xml") -Raw -Encoding UTF8).
  Replace("{{IDENTITY_NAME}}", (& $esc $IdentityName)).
  Replace("{{PUBLISHER}}", (& $esc $Publisher)).
  Replace("{{PUBLISHER_DISPLAY_NAME}}", (& $esc $PublisherDisplayName)).
  Replace("{{VERSION}}", $msixVersion)
[System.IO.File]::WriteAllText((Join-Path $layout "AppxManifest.xml"), $manifest, (New-Object System.Text.UTF8Encoding $false))

# makeappx ships with the Windows SDK; pick the newest x64 copy.
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" |
  Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (-not $makeappx) { throw "makeappx.exe not found. Install the Windows 10/11 SDK." }

$out = Join-Path $outDir "LaserPDF_${version}_x64.msix"
& $makeappx.FullName pack /d $layout /p $out /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }
Write-Host "MSIX: $out"
