@echo off
REM =====================================================================
REM  hermes-uplink  -  launcher / service manager
REM ---------------------------------------------------------------------
REM  Usage:
REM    launch.bat              -> run in foreground (console) and print passphrase
REM    launch.bat install      -> install auto-start on login (background, no window)
REM    launch.bat uninstall    -> remove auto-start
REM    launch.bat start        -> start the background service now
REM    launch.bat stop         -> stop the background service
REM    launch.bat status       -> is it running?
REM
REM  Env (optional):
REM    HERMES_PORT   port to bind        (default 8787)
REM    HERMES_BIND   bind address        (default 127.0.0.1 = loopback only)
REM                  set to 0.0.0.0 for LAN-direct access (phone on same WiFi).
REM                  loopback is safest; for phone use the Cloudflare tunnel instead.
REM    HERMES_UPSTREAM  API Server URL     (default http://127.0.0.1:8642)
REM
REM  Auto-start uses the Windows Startup folder (no admin/elevation needed; same
REM  mechanism Hermes's own gateway login item uses). It drops autostart.vbs there,
REM  which launches proxy.py headless via pythonw.
REM =====================================================================
setlocal
cd /d "%~dp0"

if /i "%1"=="install"   call :svc install & goto :eof
if /i "%1"=="uninstall" call :svc uninstall & goto :eof
if /i "%1"=="start"     call :svc start & goto :eof
if /i "%1"=="stop"      call :svc stop & goto :eof
if /i "%1"=="status"    call :svc status & goto :eof

REM ---- first-run setup (idempotent) ----
echo [*] Ensuring Hermes API Server is enabled (native Windows, no WSL2)...
hermes config set API_SERVER_ENABLED true
if not exist ".uplink-key.txt" (
  echo [*] Generating API key...
  python -c "import secrets,base64; open('.uplink-key.txt','w').write(base64.urlsafe_b64encode(secrets.token_bytes(24)).decode())"
)
set /p HERMES_API_KEY=<.uplink-key.txt
hermes config set API_SERVER_KEY %HERMES_API_KEY%
if not exist ".uplink-pass.txt" (
  python -c "import secrets,string; print(''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(8)))" > .uplink-pass.txt
)
set /p UPLINK_PASSPHRASE=<.uplink-pass.txt

echo [*] Ensuring gateway is running (API server lives inside it)...
hermes gateway restart >nul 2>&1

if "%HERMES_PORT%"=="" set HERMES_PORT=8787
if "%HERMES_BIND%"=="" set HERMES_BIND=127.0.0.1

echo.
echo ============================================================
echo  Hermes Uplink ready on this machine.
echo  URL :  http://%HERMES_BIND%:%HERMES_PORT%
echo  Pass:  %UPLINK_PASSPHRASE%   (type on first phone connect)
echo  For phone over the internet:  run tunnel.bat
echo ============================================================
echo.
set HERMES_UPSTREAM=http://127.0.0.1:8642
python proxy.py --host %HERMES_BIND% --port %HERMES_PORT%
pause
goto :eof

REM ---------- auto-start helpers (Startup folder, no elevation) ----------
:svc
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LINK=%STARTUP%\HermesUplink.vbs"
if /i not "%1"=="install" goto svc_not_install
echo [*] Installing auto-start on login (Startup folder, headless via pythonw)...
copy /Y "%~dp0autostart.vbs" "%LINK%" >nul
if exist "%LINK%" (echo [+] Installed. Starts on next logon. Run: launch.bat start) else echo [!] Failed to copy to Startup.
goto :eof
:svc_not_install
if /i not "%1"=="uninstall" goto svc_not_uninstall
if exist "%LINK%" (del /f "%LINK%" && echo [+] Removed auto-start.) else echo [!] Not installed.
goto :eof
:svc_not_uninstall
if /i not "%1"=="start" goto svc_not_start
if exist "%LINK%" (wscript "%LINK%" && echo [+] Started headless.) else echo [!] Run 'launch.bat install' first.
goto :eof
:svc_not_start
if /i not "%1"=="stop" goto svc_not_stop
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8787" ^| findstr LISTENING') do taskkill /pid %%p /t /f >nul 2>&1
echo [+] Stop signal sent.
goto :eof
:svc_not_stop
if /i not "%1"=="status" goto :eof
netstat -an | findstr ":8787" | findstr LISTENING >nul && echo [+] Running on http://127.0.0.1:8787 || echo [!] Not running (run: launch.bat start)
goto :eof


