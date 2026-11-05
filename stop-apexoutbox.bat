@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\stop.ps1"
echo.
echo  ApexOutbox stopped.
timeout /t 3 >nul
