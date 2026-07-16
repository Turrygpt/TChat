@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo Stopping TChat...
powershell -NoProfile -Command ^
  "$patterns = @('TChat', 'tchat');" ^
  "Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $cl = $_.CommandLine; $patterns | Where-Object { $cl -like ('*' + $_ + '*') } } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*start-electron*' -and $_.CommandLine -like '*TChat*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

powershell -NoProfile -Command "Start-Sleep -Seconds 2"

echo Starting TChat...
start "TChat" /D "%~dp0" cmd /c "%~dp0start.bat"
