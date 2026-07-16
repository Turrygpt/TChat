@echo off
chcp 65001 >nul
title TChat deploy
cd /d "%~dp0.."
echo Deploying TChat to server. You will be asked for the server password.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
echo.
pause
