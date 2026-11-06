@echo off
REM =====================================================================
REM  hermes-uplink - Tailscale Funnel internet-access launcher
REM  The provider workflow lives in uplink\funnel.py so it is testable.
REM =====================================================================
setlocal
cd /d "%~dp0"
title Hermes Uplink - Internet Access

if not defined HERMES_PORT set "HERMES_PORT=8787"

REM  UPLINK_PYTHON selects the interpreter, as in launch_local.bat.
set "PYEXE=python"
if defined UPLINK_PYTHON set "PYEXE=%UPLINK_PYTHON%"
"%PYEXE%" -c "" >nul 2>&1
if errorlevel 1 (
  echo [!] Python 3 was not found: install it, add it to PATH, or set UPLINK_PYTHON.
  pause
  exit /b 1
)

"%PYEXE%" -m uplink.funnel %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
if not "%~1"=="" if "%EXIT_CODE%"=="0" (
  echo.
  echo [+] Command completed successfully. Press any key to close this window.
  pause >nul
)
exit /b %EXIT_CODE%
