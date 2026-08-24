@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "ROOT=%%~fI"
set "TRAY_SCRIPT=%SCRIPT_DIR%agent-core-tray.ps1"
set "TRAY_RUNTIME=%ROOT%\runtime\tray"
set "EXIT_REQUEST=%TRAY_RUNTIME%\exit.request"

if not exist "%TRAY_RUNTIME%" mkdir "%TRAY_RUNTIME%" >nul 2>&1
> "%EXIT_REQUEST%" echo exit

rem Wait at most 15 seconds for the cooperative tray callback to stop services and release its mutex.
for /L %%I in (1,1,30) do (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%TRAY_SCRIPT%" -Mode Probe >nul 2>&1
  set "PROBE_EXIT=!ERRORLEVEL!"
  if not "!PROBE_EXIT!"=="23" goto tray_stopped
  powershell.exe -NoLogo -NoProfile -Command "Start-Sleep -Milliseconds 500" >nul 2>&1
)

:tray_stopped
rem If no tray instance owns the mutex, this fallback only stops identity-validated services recorded by the tray manager.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%TRAY_SCRIPT%" -Mode StopBundle >nul 2>&1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%uninstall-agent-core-autostart.ps1"
set "UNINSTALL_EXIT=%ERRORLEVEL%"

if exist "%TRAY_RUNTIME%" rmdir /s /q "%TRAY_RUNTIME%"
exit /b %UNINSTALL_EXIT%
