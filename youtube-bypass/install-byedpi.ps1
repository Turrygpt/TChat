# Auto-installer for ByeDPI (ciadpi.exe) - free local DPI-bypass proxy.
# Finds the latest Windows release via GitHub API and extracts ciadpi.exe here.
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $dir 'ciadpi.exe')) {
  Write-Host 'ciadpi.exe already present - nothing to do.'
  exit 0
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Write-Host 'Looking up latest ByeDPI release...'
$rel = Invoke-RestMethod -UseBasicParsing -Headers @{ 'User-Agent' = 'TChat' } `
  'https://api.github.com/repos/hufrea/byedpi/releases/latest'

$asset = $rel.assets | Where-Object { $_.name -match '(?i)(win|windows).*\.zip$' } | Select-Object -First 1
if (-not $asset) { throw 'Windows zip not found in the latest ByeDPI release.' }

$zip = Join-Path $env:TEMP $asset.name
Write-Host ("Downloading " + $asset.name)
Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $zip

$tmp = Join-Path $env:TEMP ('byedpi_' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$exe = Get-ChildItem -Path $tmp -Recurse -Filter 'ciadpi.exe' | Select-Object -First 1
if (-not $exe) { throw 'ciadpi.exe not found inside the archive.' }
Copy-Item $exe.FullName (Join-Path $dir 'ciadpi.exe') -Force

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Done: ByeDPI installed.'
