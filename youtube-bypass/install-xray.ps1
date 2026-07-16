# Auto-installer for Xray-core (Windows x64).
# Places xray.exe, geosite.dat, geoip.dat next to this script.
$ErrorActionPreference = 'Stop'

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip'
$zip = Join-Path $env:TEMP 'Xray-windows-64.zip'

if (Test-Path (Join-Path $dir 'xray.exe')) {
  Write-Host 'xray.exe already present - nothing to do.'
  exit 0
}

Write-Host "Downloading Xray-core:"
Write-Host "  $url"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

$tmp = Join-Path $env:TEMP ('xray_' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
Expand-Archive -Path $zip -DestinationPath $tmp -Force

$ok = $true
foreach ($name in 'xray.exe', 'geosite.dat', 'geoip.dat') {
  $src = Join-Path $tmp $name
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $dir $name) -Force
    Write-Host "  OK: $name"
  } else {
    Write-Warning "  missing in archive: $name"
    if ($name -eq 'xray.exe') { $ok = $false }
  }
}

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

if ($ok) { Write-Host 'Done: Xray installed.' } else { throw 'Failed to extract xray.exe from the archive.' }
