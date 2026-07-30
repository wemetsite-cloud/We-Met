@echo off
setlocal
cd /d "%~dp0"
title We Met V4.1 Safe Setup
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or is not in PATH.
  echo Install Node.js LTS, restart Windows, then run this file again.
  pause
  exit /b 1
)
node tools\setup.js
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Installing backend packages...
call npm run install:backend
if errorlevel 1 (
  echo Package installation failed.
  pause
  exit /b 1
)
echo.
echo Creating/upgrading Supabase tables and updating the first accounts...
call npm run db:init
if errorlevel 1 (
  echo Database initialization failed. Check the DATABASE_URL in backend\.env.
  pause
  exit /b 1
)
node tools\finalize-setup.js
if errorlevel 1 (
  echo Setup completed, but RESET_SEEDED_PASSWORDS could not be turned off automatically.
  echo Open backend\.env and set RESET_SEEDED_PASSWORDS=false manually.
  pause
  exit /b 1
)
echo.
echo ==============================================
echo WE MET V4.1 SETUP COMPLETED
echo Run START_WINDOWS.bat to start the platform.
echo ==============================================
pause
