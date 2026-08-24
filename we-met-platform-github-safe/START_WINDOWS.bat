@echo off
cd /d "%~dp0"
title We Met 8 Server
if not exist .env (
  echo .env is missing.
  echo Copy .env.example to .env and enter your local values.
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
