@echo off
setlocal
set "AGENT_CORE_ROOT=%~dp0"
set "AGENT_CORE_LAUNCHER=%AGENT_CORE_ROOT%scripts\windows\agent-core-launcher.ps1"

if not exist "%AGENT_CORE_LAUNCHER%" (
  echo [ERROR] Agent Core launcher engine was not found:
  echo %AGENT_CORE_LAUNCHER%
  pause
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%AGENT_CORE_LAUNCHER%"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] Agent Core failed to start. Exit code: %EXIT_CODE%
  pause
)
exit /b %EXIT_CODE%
