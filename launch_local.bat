@echo off
REM =====================================================================
REM  hermes-uplink  -  launcher / service manager
REM ---------------------------------------------------------------------
REM  Usage:
REM    launch_local.bat              -> set up, then run the proxy in the foreground
REM    launch_local.bat install      -> install auto-start on login (background, no window)
REM    launch_local.bat uninstall    -> remove auto-start
REM    launch_local.bat start        -> start the background service now
REM    launch_local.bat stop         -> stop the background service
REM    launch_local.bat status       -> is it running?
REM
REM  Env (optional):
REM    HERMES_PORT      port to bind      (default 8787)
REM    HERMES_UPSTREAM  API Server URL    (default http://127.0.0.1:8642)
REM
REM  Setup (credentials, Hermes configuration, gateway restart) lives in
REM  uplink_setup.py. "install" drops a launcher into the per-user Startup
REM  folder (no admin needed); it runs windows\autostart.vbs, which starts
REM  proxy.py headless via pythonw.
REM =====================================================================
setlocal
cd /d "%~dp0"
title Hermes Uplink - Local Proxy

if not defined HERMES_PORT set "HERMES_PORT=8787"

if /i "%~1"=="install"   call :svc install & goto :eof
if /i "%~1"=="uninstall" call :svc uninstall & goto :eof
if /i "%~1"=="start"     call :svc start & goto :eof
if /i "%~1"=="stop"      call :svc stop & goto :eof
if /i "%~1"=="status"    call :svc status & goto :eof

where python >nul 2>&1
if errorlevel 1 (
  echo [!] Python 3 is not installed or not in your PATH. Please install it to continue.
  pause
  exit /b 1
)
python uplink_setup.py
if errorlevel 1 (
  pause
  exit /b 1
)
python proxy.py --port "%HERMES_PORT%"
if errorlevel 1 echo [!] Hermes Uplink stopped with an error.
pause
goto :eof

REM ---------- auto-start helpers (Startup folder, no elevation) ----------
:svc
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\HermesUplink.vbs"
goto svc_%1

:svc_install
echo [*] Installing auto-start on login (Startup folder, headless via pythonw)...
echo CreateObject("WScript.Shell").Run "wscript.exe ""%~dp0windows\autostart.vbs""", 0, False > "%LINK%"
if exist "%LINK%" (echo [+] Installed. Starts on next logon. Run: launch_local.bat start) else echo [!] Failed to write to the Startup folder.
goto :eof

:svc_uninstall
if exist "%LINK%" (del /f "%LINK%" && echo [+] Removed auto-start.) else echo [!] Not installed.
goto :eof

:svc_start
if exist "%LINK%" (wscript "%LINK%" && echo [+] Started headless.) else echo [!] Run 'launch_local.bat install' first.
goto :eof

:svc_stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\service.ps1" -Action stop -Port %HERMES_PORT%
goto :eof

:svc_status
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\service.ps1" -Action status -Port %HERMES_PORT%
goto :eof
