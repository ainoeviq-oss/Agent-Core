@echo off
setlocal
cd /d "%~dp0"
title Commander MCP

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

echo [START] http://127.0.0.1:8765/mcp
echo [INFO] Press Ctrl+C to stop the server.
node dist\index.js
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Commander MCP exited with code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
