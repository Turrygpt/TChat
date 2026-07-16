@echo off
cd /d "%~dp0"
title TChat YouTube bypass (ByeDPI - free)

REM Free backend: local DPI-desync proxy on 127.0.0.1:10810 (HTTP/SOCKS).
REM Use EITHER this OR run-xray.bat - not both (same port 10810).
REM TChat needs no changes: youtube-proxy.json already points at 127.0.0.1:10810.

if not exist ciadpi.exe (
  echo ciadpi.exe not found - installing automatically...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-byedpi.ps1"
)

if not exist ciadpi.exe (
  echo.
  echo [!] Could not install ByeDPI automatically.
  echo Download it manually from: https://github.com/hufrea/byedpi/releases
  echo and put ciadpi.exe into this folder:
  echo    "%~dp0"
  echo.
  pause
  exit /b 1
)

echo Starting ByeDPI on 127.0.0.1:10810 (free, no server, DPI desync).
echo If YouTube still buffers, try another preset - see README-youtube-proxy.md.
ciadpi.exe -i 127.0.0.1 -p 10810
