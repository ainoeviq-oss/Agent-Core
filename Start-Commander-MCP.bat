@echo off
setlocal
cd /d "%~dp0"
title Commander MCP

set "COMMANDER_HOME=%~dp0"
set "COMMANDER_GIT_COMMON="
for /f "delims=" %%I in ('git -C "%~dp0" rev-parse --git-common-dir 2^>nul') do set "COMMANDER_GIT_COMMON=%%I"
if defined COMMANDER_GIT_COMMON for %%I in ("%COMMANDER_GIT_COMMON%\..") do set "COMMANDER_HOME=%%~fI"

if not defined COMMANDER_DATA_DIR set "COMMANDER_DATA_DIR=%COMMANDER_HOME%\runtime\data"
if not defined COMMANDER_LOG_DIR set "COMMANDER_LOG_DIR=%COMMANDER_HOME%\runtime\logs"
if not defined COMMANDER_CAPABILITY_DIR set "COMMANDER_CAPABILITY_DIR=%COMMANDER_HOME%\capabilities"
if not defined COMMANDER_ALLOWED_ROOTS set "COMMANDER_ALLOWED_ROOTS=%COMMANDER_HOME%"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules\@modelcontextprotocol\sdk\package.json" (
  echo [SETUP] Installing Commander MCP dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

echo [BUILD] Compiling Commander MCP...
call npm.cmd run build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo [HOME] %COMMANDER_HOME%
echo [CAPABILITIES] %COMMANDER_CAPABILITY_DIR%
echo [START] http://127.0.0.1:8765/mcp
echo [INFO] Press Ctrl+C to stop the server.
node dist\index.js
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Commander MCP exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
