@echo off
chcp 65001 >nul
title Restore pm2 apps
cd /d "%~dp0.."
echo Restoring your other apps (gemini-app, tgbot) on the server.
echo You will be asked for the server password.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-apps.ps1"
echo.
pause
