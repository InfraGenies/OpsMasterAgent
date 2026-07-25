@echo off
rem Double-clickable entry point for start-app.ps1 (Windows Explorer runs .cmd
rem directly but opens .ps1 in Notepad by default, and a plain PowerShell
rem console may block script execution under the default policy) - this
rem always launches with -ExecutionPolicy Bypass so it works either way.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-app.ps1" %*
pause
