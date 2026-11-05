@echo off
setlocal
cd /d "%~dp0"
title ApexOutbox launcher
echo.
echo  ApexOutbox - starting...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js was not found. Install Node 20 or newer from nodejs.org, then run this again.
  pause
  exit /b 1
)
if not exist ".env" (
  echo  The .env file is missing in this folder. Create it first ^(see README^).
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo  First run: installing packages, this takes a minute...
  call npm ci
  if errorlevel 1 ( echo  npm ci failed. & pause & exit /b 1 )
)

echo  Stopping any old copy...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\stop.ps1" -Quiet

echo  Starting the API and the worker ^(two small windows, leave them open^)...
start "ApexOutbox API" /min cmd /k "title ApexOutbox API & npm run dev"
start "ApexOutbox Worker" /min cmd /k "title ApexOutbox Worker & npm run dev:worker"

echo  Waiting for the app to be ready...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\wait-ready.ps1"
if errorlevel 1 (
  echo.
  echo  The app did not become ready in time. Look at the "ApexOutbox API" window in the taskbar:
  echo  the red text there says why. Common causes: no internet, wrong MONGODB_URI or REDIS_URL in .env.
  pause
  exit /b 1
)

echo.
echo  Ready. Opening http://localhost:3000
start "" http://localhost:3000
echo  You can close this window. To stop everything, run stop-apexoutbox.bat.
timeout /t 5 >nul
endlocal
