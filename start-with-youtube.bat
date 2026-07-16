@echo off
cd /d "%~dp0"
title TChat (+YouTube proxy)

echo [1/2] Starting YouTube bypass (Xray, local proxy 127.0.0.1:10810)...
start "TChat-YouTube-Proxy" /min cmd /c "%~dp0youtube-bypass\run-xray.bat"

echo Waiting 2 seconds for the proxy to come up...
timeout /t 2 >nul

echo [2/2] Starting TChat...
call "%~dp0start.bat"
