@echo off
chcp 65001 >nul
title TChat
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting TChat...
npm start

if errorlevel 1 (
  echo TChat exited with an error.
  pause
)
