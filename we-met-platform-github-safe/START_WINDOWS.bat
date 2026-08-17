@echo off
cd /d "%~dp0"
title We Met 6 Server
if not exist backend\.env (
  echo backend\.env is missing.
  echo Copy backend\.env.example to backend\.env and enter your production values.
  pause
  exit /b 1
)
if not exist backend\node_modules call npm --prefix backend ci
if errorlevel 1 (
  pause
  exit /b 1
)
call npm start
pause
