@echo off
cd /d "%~dp0"
title We Met Safe GitHub Copy
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  pause
  exit /b 1
)
node tools\make-safe-upload-copy.js
if errorlevel 1 (
  echo Safe-copy creation failed.
  pause
  exit /b 1
)
pause
