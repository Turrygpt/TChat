param([string]$ServerHost = "195.62.49.244", [string]$ServerUser = "root")
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = "$ServerUser@$ServerHost"
$LocalSh = Join-Path $ScriptDir "fix-gemini.sh"
Write-Host ">> Uploading fix script (enter password when asked)..."
scp -o StrictHostKeyChecking=accept-new "$LocalSh" "${Target}:/tmp/fix-gemini.sh"
Write-Host ">> Running it on the server (enter password again if asked)..."
ssh -o StrictHostKeyChecking=accept-new "$Target" "bash /tmp/fix-gemini.sh; rm -f /tmp/fix-gemini.sh"
Write-Host ""
Write-Host "Done."
