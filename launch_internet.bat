@echo off
REM =====================================================================
REM  hermes-uplink - Tailscale Funnel internet-access launcher
REM  The provider workflow lives in internet_access.py so it is testable.
REM =====================================================================
setlocal
cd /d "%~dp0"
title Hermes Uplink - Internet Access

if not defined HERMES_PORT set "HERMES_PORT=8787"

where python >nul 2>&1
if errorlevel 1 (
  echo [!] Python 3 is not installed or not available in PATH.
  pause
  exit /b 1
)

python "%~dp0internet_access.py" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
if not "%~1"=="" if "%EXIT_CODE%"=="0" (
  echo.
  echo [+] Command completed successfully. Press any key to close this window.
  pause >nul
)
exit /b %EXIT_CODE%
