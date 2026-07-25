@echo off
rem Double-clickable entry point for stop-app.ps1 - see start-app.cmd.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-app.ps1" %*
pause
