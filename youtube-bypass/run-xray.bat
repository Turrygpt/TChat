@echo off
cd /d "%~dp0"
title TChat YouTube proxy (Xray VLESS)

if not exist xray.exe (
  echo xray.exe not found - installing automatically...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-xray.ps1"
)

if not exist xray.exe (
  echo.
  echo [!] Could not install xray.exe automatically.
  echo Download Xray-windows-64.zip manually from:
  echo    https://github.com/XTLS/Xray-core/releases
  echo and put xray.exe, geosite.dat, geoip.dat into this folder:
  echo    "%~dp0"
  echo.
  pause
  exit /b 1
)

echo Starting Xray: local HTTP proxy 127.0.0.1:10810 - only YouTube goes out.
xray.exe run -c "%~dp0xray-config.json"
