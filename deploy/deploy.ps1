# TChat -> VPS deploy from Windows (no WSL/bash needed).
# Uses built-in Windows tools: tar, ssh, scp (Windows 10 1809+ / Windows 11).
# You will be asked for the server password 1-2 times (that's normal).
#
# Run: right-click deploy\deploy-windows.bat -> it calls this script.
# Or:  powershell -ExecutionPolicy Bypass -File deploy\deploy.ps1

param(
  [string]$ServerHost = "195.62.49.244",
  [string]$ServerUser = "root",
  [string]$RemoteDir  = "/opt/tchat",
  [int]$Port          = 3000
)

$ErrorActionPreference = "Stop"

# Project root = parent of this script's folder
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

Write-Host ">> Project: $ProjectDir"

# Check required tools
foreach ($tool in @("ssh","scp","tar")) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: '$tool' not found. Needs Windows 10 1809+ or Windows 11." -ForegroundColor Red
    Write-Host "Install OpenSSH client: Settings > Apps > Optional features > OpenSSH Client."
    exit 1
  }
}

$Tar = Join-Path $env:TEMP "tchat-deploy.tgz"
if (Test-Path $Tar) { Remove-Item $Tar -Force }

Write-Host ">> Packing project (excluding node_modules, youtube-bypass, caches)..."
tar -czf "$Tar" `
  --exclude=.git `
  --exclude=node_modules `
  --exclude=dist `
  --exclude=android `
  --exclude=build `
  --exclude=youtube-bypass `
  --exclude=assets/tts `
  -C "$ProjectDir" .
if ($LASTEXITCODE -ne 0) { Write-Host "tar failed" -ForegroundColor Red; exit 1 }

$Target = "$ServerUser@$ServerHost"
Write-Host ">> Uploading to $Target (enter password when asked)..."
scp -o StrictHostKeyChecking=accept-new "$Tar" "${Target}:/tmp/tchat-deploy.tgz"
if ($LASTEXITCODE -ne 0) { Write-Host "scp failed" -ForegroundColor Red; exit 1 }

Write-Host ">> Installing on server (enter password again if asked)..."
$RemoteCmd = "mkdir -p $RemoteDir && tar -xzf /tmp/tchat-deploy.tgz -C $RemoteDir && rm -f /tmp/tchat-deploy.tgz && REMOTE_DIR='$RemoteDir' PORT='$Port' bash $RemoteDir/deploy/remote-setup.sh"
ssh -o StrictHostKeyChecking=accept-new "$Target" "$RemoteCmd"
if ($LASTEXITCODE -ne 0) { Write-Host "remote setup failed" -ForegroundColor Red; exit 1 }

Remove-Item $Tar -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "DONE. Check in browser:" -ForegroundColor Green
Write-Host "  http://$ServerHost/           (landing + remote panel)"
Write-Host "  http://$ServerHost/health     (status)"
Write-Host "  http://$ServerHost/widgets/stream.html   (overlay for Prizm)"
