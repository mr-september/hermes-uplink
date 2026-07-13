@echo off
REM =====================================================================
REM  hermes-uplink  -  launcher / service manager
REM ---------------------------------------------------------------------
REM  Usage:
REM    launch_local.bat              -> run in foreground (console) and print passphrase
REM    launch_local.bat install      -> install auto-start on login (background, no window)
REM    launch_local.bat uninstall    -> remove auto-start
REM    launch_local.bat start        -> start the background service now
REM    launch_local.bat stop         -> stop the background service
REM    launch_local.bat status       -> is it running?
REM
REM  Env (optional):
REM    HERMES_PORT   port to bind        (default 8787)
REM    HERMES_UPSTREAM  API Server URL     (default http://127.0.0.1:8642)
REM  mechanism Hermes's own gateway login item uses). It drops autostart.vbs there,
REM  which launches proxy.py headless via pythonw.
REM =====================================================================
setlocal
cd /d "%~dp0"
title Hermes Uplink - Local Proxy

if not defined HERMES_PORT set "HERMES_PORT=8787"
set "HERMES_BIND=127.0.0.1"
call :validate_port
if errorlevel 1 (
  pause
  exit /b 1
)

if /i "%~1"=="install"   call :svc install & goto :eof
if /i "%~1"=="uninstall" call :svc uninstall & goto :eof
if /i "%~1"=="start"     call :svc start & goto :eof
if /i "%~1"=="stop"      call :svc stop & goto :eof
if /i "%~1"=="status"    call :svc status & goto :eof

REM ---- verify core command-line environments ----
where python >nul 2>&1
if errorlevel 1 (
  echo [!] Python 3 is not installed or not in your PATH. Please install it to continue.
  pause
  exit /b 1
)
where hermes >nul 2>&1
if errorlevel 1 (
  echo [!] 'hermes' command-line interface was not found in your PATH.
  pause
  exit /b 1
)

REM ---- first-run setup (idempotent) ----
echo [*] Ensuring Hermes API Server is enabled...
for /f "delims=" %%I in ('hermes config path') do set "CONFIG_PATH=%%I"
findstr /R /C:"^API_SERVER_ENABLED:[ ]*true" "%CONFIG_PATH%" >nul 2>&1
if errorlevel 1 (
  hermes config set API_SERVER_ENABLED true
  if errorlevel 1 (
    echo [!] Hermes API configuration failed.
    pause
    exit /b 1
  )
)
if not exist ".uplink-key.txt" (
  echo [*] Generating API key...
  python -c "import secrets,base64; open('.uplink-key.txt','w',encoding='ascii',newline='').write(base64.urlsafe_b64encode(secrets.token_bytes(24)).decode())"
  if errorlevel 1 (
    echo [!] API key generation failed.
    pause
    exit /b 1
  )
)
set "HERMES_API_KEY="
set /p HERMES_API_KEY=<.uplink-key.txt
if not defined HERMES_API_KEY (
  echo [!] API key file is empty.
  pause
  exit /b 1
)
set "API_KEY_VALID="
for /f "delims=" %%R in ('powershell -NoProfile -Command "$k=(Get-Content -LiteralPath '.uplink-key.txt' -Raw).Trim(); if($k -match '^[A-Za-z0-9_-]{32}$'){ 'OK' }"') do set "API_KEY_VALID=%%R"
if /i not "%API_KEY_VALID%"=="OK" (
  echo [!] API key file has an invalid format; refusing to pass it to Hermes.
  pause
  exit /b 1
)
findstr /C:"API_SERVER_KEY: %HERMES_API_KEY%" "%CONFIG_PATH%" >nul 2>&1
if errorlevel 1 (
  findstr /C:"API_SERVER_KEY: '%HERMES_API_KEY%'" "%CONFIG_PATH%" >nul 2>&1
  if errorlevel 1 (
    hermes config set API_SERVER_KEY "%HERMES_API_KEY%"
    if errorlevel 1 (
      echo [!] Hermes API key configuration failed.
      pause
      exit /b 1
    )
  )
)
echo [*] Checking passphrase strength...
python -c "import os,secrets,string; p='.uplink-pass.txt'; v=open(p,encoding='ascii').read().strip() if os.path.exists(p) else ''; v=v if len(v)>=20 and v.isalnum() else ''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)); open(p,'w',encoding='ascii',newline='').write(v)"
if errorlevel 1 (
  echo [!] Passphrase generation failed.
  pause
  exit /b 1
)
set "UPLINK_PASSPHRASE="
set /p UPLINK_PASSPHRASE=<.uplink-pass.txt
if not defined UPLINK_PASSPHRASE (
  echo [!] Passphrase file is empty.
  pause
  exit /b 1
)

echo [*] Ensuring gateway is running (API server lives inside it)...
hermes gateway restart
if errorlevel 1 (
  echo [!] Hermes gateway restart failed. The proxy was not started.
  pause
  exit /b 1
)


echo.
echo ============================================================
echo  Hermes Uplink ready on this machine.
echo  URL :  http://127.0.0.1:%HERMES_PORT% (local browser only)
echo  Pass:  %UPLINK_PASSPHRASE%   (type on connect)
echo  For phone access:  run launch_internet.bat for an HTTPS URL
echo ============================================================
echo.
if not defined HERMES_UPSTREAM set "HERMES_UPSTREAM=http://127.0.0.1:8642"
python proxy.py --host "%HERMES_BIND%" --port "%HERMES_PORT%"
if errorlevel 1 echo [!] Hermes Uplink stopped with an error.
pause
goto :eof

REM ---------- auto-start helpers (Startup folder, no elevation) ----------
:svc
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LINK=%STARTUP%\HermesUplink.vbs"
if /i not "%1"=="install" goto svc_not_install
echo [*] Installing auto-start on login (Startup folder, headless via pythonw)...
echo Dim WShell > "%LINK%"
echo Set WShell = CreateObject("WScript.Shell") >> "%LINK%"
echo WShell.CurrentDirectory = """%~dp0""" >> "%LINK%"
echo WShell.Run "wscript.exe autostart.vbs", 0, False >> "%LINK%"
if exist "%LINK%" (echo [+] Installed. Starts on next logon. Run: launch_local.bat start) else echo [!] Failed to copy to Startup.
goto :eof
:svc_not_install
if /i not "%1"=="uninstall" goto svc_not_uninstall
if exist "%LINK%" (del /f "%LINK%" && echo [+] Removed auto-start.) else echo [!] Not installed.
goto :eof
:svc_not_uninstall
if /i not "%1"=="start" goto svc_not_start
if exist "%LINK%" (wscript "%LINK%" && echo [+] Started headless.) else echo [!] Run 'launch_local.bat install' first.
goto :eof
:svc_not_start
if /i not "%1"=="stop" goto svc_not_stop
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service.ps1" -Action stop -Port %HERMES_PORT%
goto :eof
:svc_not_stop
if /i not "%1"=="status" goto :eof
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service.ps1" -Action status -Port %HERMES_PORT%
goto :eof

:validate_port
set "PORT_VALID="
for /f "delims=" %%R in ('powershell -NoProfile -Command "$p=$env:HERMES_PORT; if($p -match '^[0-9]+$' -and [int]$p -ge 1 -and [int]$p -le 65535){ 'OK' }"') do set "PORT_VALID=%%R"
if /i not "%PORT_VALID%"=="OK" (
  echo [!] HERMES_PORT must be a decimal TCP port from 1 through 65535.
  exit /b 1
)
exit /b 0

