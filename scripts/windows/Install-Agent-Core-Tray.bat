@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-agent-core-autostart.ps1" -ControlledTakeover -StartNow
exit /b %errorlevel%
