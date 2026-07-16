# Restore pm2 apps on the server. Run from your PC (Windows 10/11).
# Uploads a clean shell script and runs it — no fragile inline quoting.
param(
  [string]$ServerHost = "195.62.49.244",
  [string]$ServerUser = "root"
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$ServerUser@$ServerHost"
$LocalSh = Join-Path $ScriptDir "restore-apps.sh"

Write-Host ">> Uploading restore script (enter password when asked)..."
scp -o StrictHostKeyChecking=accept-new "$LocalSh" "${Target}:/tmp/tchat-restore.sh"

Write-Host ">> Running it on the server (enter password again if asked)..."
ssh -o StrictHostKeyChecking=accept-new "$Target" "bash /tmp/tchat-restore.sh; rm -f /tmp/tchat-restore.sh"

Write-Host ""
Write-Host "Done. TChat: http://$ServerHost/tchat/"
