@echo off
setlocal
cd /d "%~dp0"
title Agent Core

set "AGENT_CORE_HOME=%~dp0"
set "AGENT_CORE_GIT_COMMON="
for /f "delims=" %%I in ('git -C "%~dp0" rev-parse --git-common-dir 2^>nul') do set "AGENT_CORE_GIT_COMMON=%%I"
if defined AGENT_CORE_GIT_COMMON for %%I in ("%AGENT_CORE_GIT_COMMON%\..") do set "AGENT_CORE_HOME=%%~fI"

if not defined AGENT_CORE_DATA_DIR set "AGENT_CORE_DATA_DIR=%AGENT_CORE_HOME%\runtime\data"
if not defined AGENT_CORE_LOG_DIR set "AGENT_CORE_LOG_DIR=%AGENT_CORE_HOME%\runtime\logs"
if not defined AGENT_CORE_CAPABILITY_DIR set "AGENT_CORE_CAPABILITY_DIR=%AGENT_CORE_HOME%\capabilities"
if not defined AGENT_CORE_ALLOWED_ROOTS set "AGENT_CORE_ALLOWED_ROOTS=%AGENT_CORE_HOME%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules\@modelcontextprotocol\sdk\package.json" (
  echo [SETUP] Installing Agent Core dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo [BUILD] Compiling Agent Core...
call npm.cmd run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo [HOME] %AGENT_CORE_HOME%
echo [CAPABILITIES] %AGENT_CORE_CAPABILITY_DIR%
echo [START] http://127.0.0.1:8765/mcp
echo [INFO] Press Ctrl+C to stop the server.
node dist\index.js
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Agent Core exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
