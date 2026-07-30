@echo off
cd /d "%~dp0"
title We Met V4.1 Server
if not exist backend\.env (
  echo backend\.env is missing. Run SETUP_WINDOWS.bat first.
  pause
  exit /b 1
)
call npm start
pause
