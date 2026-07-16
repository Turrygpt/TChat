@echo off
chcp 65001 >nul
title Fix gemini-app
cd /d "%~dp0.."
echo Fixing gemini-app (moving it off port 80 so it stops crashing).
echo You will be asked for the server password.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-gemini.ps1"
echo.
pause
