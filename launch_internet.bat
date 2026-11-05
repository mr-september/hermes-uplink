@echo off
REM =====================================================================
REM  hermes-uplink - Tailscale Funnel internet-access launcher
REM  The provider workflow lives in uplink\funnel.py so it is testable.
REM =====================================================================
setlocal
cd /d "%~dp0"
title Hermes Uplink - Internet Access

if not defined HERMES_PORT set "HERMES_PORT=8787"

REM  Same pinned interpreter as launch_local.bat (see comment there).
set "PYEXE=C:\Users\Larry\AppData\Roaming\uv\python\cpython-3.14-windows-x86_64-none\python.exe"

if not exist "%PYEXE%" (
  echo [!] Pinned Python 3.14 not found at "%PYEXE%". Update PYEXE in this file.
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
