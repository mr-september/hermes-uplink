@echo off
REM =====================================================================
REM  hermes-uplink - expose over the internet via Cloudflare Tunnel
REM  tunnel.bat          -> quick tunnel (no account; rotating URL)
REM  tunnel.bat named    -> stable named tunnel (free account + login)
REM  tunnel.bat cleanup  -> delete the named tunnel
REM =====================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "CLOUDFLARED_VERSION=2026.7.1"
set "CLOUDFLARED_SHA256=CCB0756DE288D3C2C076D19764CA53E0849A10F2DD9C23F8656AC42BDEB45001"
set "CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/download/%CLOUDFLARED_VERSION%/cloudflared-windows-amd64.exe"
set "TUNNEL_NAME=hermes-uplink"
set "TUNNEL_ID_FILE=.uplink-tunnel-id.txt"
set "CF_DIR=%USERPROFILE%\.cloudflared"
if not defined HERMES_PORT set "HERMES_PORT=8787"

if /i "%~1"=="named"   call :named   & goto :eof
if /i "%~1"=="cleanup" call :cleanup & goto :eof

REM ---------- quick tunnel (default, unchanged behavior) ----------
call :validate_port
if errorlevel 1 ( pause & exit /b 1 )
call :load_passphrase
if errorlevel 1 ( pause & exit /b 1 )
call :verify_local_proxy
if errorlevel 1 ( pause & exit /b 1 )

call :ensure_cloudflared
if errorlevel 1 ( pause & exit /b 1 )

echo.
echo ============================================================
echo  Tunnel URL appears below. Share it together with the passphrase:
echo    Passphrase: %UPLINK_PASSPHRASE%
echo  URL alone is not enough, the passphrase gate is on.
echo ============================================================
echo.
call "bin\cloudflared.exe" tunnel --no-prechecks --no-autoupdate --protocol http2 --url "http://127.0.0.1:%HERMES_PORT%"
pause
goto :eof

:named
call :validate_port
if errorlevel 1 ( pause & exit /b 1 )
call :load_passphrase
if errorlevel 1 ( pause & exit /b 1 )
call :verify_local_proxy
if errorlevel 1 ( pause & exit /b 1 )
call :ensure_cloudflared
if errorlevel 1 ( pause & exit /b 1 )

set "TUNNEL_UUID="
set "TUNNEL_NEW="
if exist "%TUNNEL_ID_FILE%" (
  set /p TUNNEL_UUID=<"%TUNNEL_ID_FILE%"
  call :validate_tunnel_uuid
  if errorlevel 1 (
    echo [!] The local tunnel state file is invalid. Remove it only after checking the Cloudflare dashboard.
    pause & exit /b 1
  )
) else (
  if not exist "%CF_DIR%\cert.pem" (
    echo [*] No Cloudflare account certificate found. A browser will open for one-time login.
    echo     This certificate can manage tunnels in the selected account; use a dedicated account where possible.
    echo     Log in, then re-run: tunnel.bat named
    echo.
    call "bin\cloudflared.exe" login
    if errorlevel 1 ( echo [!] Login failed or was cancelled. & pause & exit /b 1 )
    echo [+] Login complete. Re-run: tunnel.bat named
    pause & exit /b 0
  )

  echo [*] Checking whether tunnel name "%TUNNEL_NAME%" is already in use...
  set "TUNNEL_LIST_LOG=%TEMP%\hermes-uplink-tunnel-list-%RANDOM%.log"
  "bin\cloudflared.exe" tunnel list --name "%TUNNEL_NAME%" >"!TUNNEL_LIST_LOG!" 2>&1
  if errorlevel 1 (
    type "!TUNNEL_LIST_LOG!"
    del /f /q "!TUNNEL_LIST_LOG!" >nul 2>&1
    echo [!] Cloudflare tunnel listing failed; refusing to guess or create a duplicate.
    pause & exit /b 1
  )
  findstr /i /c:"%TUNNEL_NAME%" "!TUNNEL_LIST_LOG!" >nul
  if not errorlevel 1 (
    del /f /q "!TUNNEL_LIST_LOG!" >nul 2>&1
    echo [!] A tunnel named "%TUNNEL_NAME%" already exists but is not managed by this checkout.
    echo     Rename or remove that tunnel deliberately, then re-run this command.
    pause & exit /b 1
  )
  del /f /q "!TUNNEL_LIST_LOG!" >nul 2>&1

  echo [*] Creating tunnel "%TUNNEL_NAME%"...
  set "TUNNEL_CREATE_LOG=%TEMP%\hermes-uplink-tunnel-create-%RANDOM%.log"
  "bin\cloudflared.exe" tunnel create "%TUNNEL_NAME%" >"!TUNNEL_CREATE_LOG!" 2>&1
  if errorlevel 1 (
    type "!TUNNEL_CREATE_LOG!"
    del /f /q "!TUNNEL_CREATE_LOG!" >nul 2>&1
    echo [!] Tunnel create failed.
    pause & exit /b 1
  )
  for /f "delims=" %%U in ('powershell -NoProfile -Command "$t=Get-Content -LiteralPath $env:TUNNEL_CREATE_LOG -Raw; if($t -match '(?im)with id ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'){ $Matches[1] }"') do set "TUNNEL_UUID=%%U"
  type "!TUNNEL_CREATE_LOG!"
  del /f /q "!TUNNEL_CREATE_LOG!" >nul 2>&1
  call :validate_tunnel_uuid
  if errorlevel 1 (
    echo [!] Tunnel was created but its UUID could not be recovered safely.
    echo     Inspect the Cloudflare dashboard before retrying; do not delete by name.
    pause & exit /b 1
  )
  set "TUNNEL_NEW=1"
)

if "%TUNNEL_NEW%"=="1" >"%TUNNEL_ID_FILE%" echo %TUNNEL_UUID%

if not exist "%CF_DIR%\%TUNNEL_UUID%.json" (
  echo [!] Tunnel credentials are missing: "%CF_DIR%\%TUNNEL_UUID%.json"
  echo     Restore that file or run tunnel.bat cleanup after verifying the account state.
  pause & exit /b 1
)

echo.
echo ============================================================
echo  Stable URL (persists across restarts). Share it with the
echo  passphrase from launch.bat. The URL alone is not enough.
echo.
echo  https://%TUNNEL_UUID%.cfargotunnel.com
echo ============================================================
echo.
call "bin\cloudflared.exe" tunnel run --no-prechecks --no-autoupdate --protocol http2 --url "http://127.0.0.1:%HERMES_PORT%" %TUNNEL_UUID%
pause
goto :eof

:cleanup
if not exist "%TUNNEL_ID_FILE%" (
  echo [!] No tunnel state file exists; refusing to delete by generic name.
  echo     Inspect the Cloudflare dashboard and remove the intended tunnel there.
  pause & exit /b 1
)
set "TUNNEL_UUID="
set /p TUNNEL_UUID=<"%TUNNEL_ID_FILE%"
call :validate_tunnel_uuid
if errorlevel 1 (
  echo [!] The local tunnel state file is invalid; refusing to delete anything.
  pause & exit /b 1
)
call :ensure_cloudflared
if errorlevel 1 ( pause & exit /b 1 )
echo [!] This will permanently delete tunnel %TUNNEL_UUID% from the current Cloudflare account.
choice /c YN /n /m "Continue"
if errorlevel 2 ( echo [*] Cancelled. & exit /b 0 )
"bin\cloudflared.exe" tunnel delete --force "%TUNNEL_UUID%"
if errorlevel 1 ( echo [!] Delete failed. & pause & exit /b 1 )
del /f /q "%TUNNEL_ID_FILE%" >nul 2>&1
if exist "%CF_DIR%\%TUNNEL_UUID%.json" del /f /q "%CF_DIR%\%TUNNEL_UUID%.json" >nul 2>&1
echo [+] Tunnel deleted. The account certificate remains available for other Cloudflare tunnels.
pause
goto :eof

:validate_port
set "PORT_VALID="
for /f "delims=" %%R in ('powershell -NoProfile -Command "$p=$env:HERMES_PORT; if($p -match '^[0-9]+$' -and [int]$p -ge 1 -and [int]$p -le 65535){ 'OK' }"') do set "PORT_VALID=%%R"
if /i not "%PORT_VALID%"=="OK" (
  echo [!] HERMES_PORT must be a decimal TCP port from 1 through 65535.
  exit /b 1
)
exit /b 0

:load_passphrase
set "UPLINK_PASSPHRASE="
if not exist ".uplink-pass.txt" (
  echo [!] Run launch.bat first so the passphrase exists.
  exit /b 1
)
set /p UPLINK_PASSPHRASE=<".uplink-pass.txt"
if not defined UPLINK_PASSPHRASE (
  echo [!] Passphrase file is empty. Run launch.bat first.
  exit /b 1
)
set "PASS_VALID="
for /f "delims=" %%R in ('powershell -NoProfile -Command "$p=(Get-Content -LiteralPath '.uplink-pass.txt' -Raw).Trim(); if($p -match '^[A-Za-z0-9]{20,}$'){ 'OK' }"') do set "PASS_VALID=%%R"
if /i not "%PASS_VALID%"=="OK" (
  echo [!] Passphrase must be at least 20 alphanumeric characters. Run launch.bat to regenerate it.
  exit /b 1
)
exit /b 0

:verify_local_proxy
set "PROXY_SERVER_HEADER="
for /f "delims=" %%H in ('curl.exe --silent --show-error --connect-timeout 2 --max-time 5 -D - -o NUL "http://127.0.0.1:%HERMES_PORT%/" 2^>nul ^| findstr /i /c:"Server: HermesUplink"') do set "PROXY_SERVER_HEADER=%%H"
if not defined PROXY_SERVER_HEADER (
  echo [!] No Hermes Uplink proxy was detected on 127.0.0.1:%HERMES_PORT%.
  echo     Run launch.bat first and ensure the proxy is healthy.
  exit /b 1
)
set "PROXY_AUTH_STATUS="
for /f "delims=" %%S in ('curl.exe --silent --show-error --connect-timeout 2 --max-time 5 -o NUL -w "%%{http_code}" "http://127.0.0.1:%HERMES_PORT%/api/sessions" 2^>nul') do set "PROXY_AUTH_STATUS=%%S"
if not "%PROXY_AUTH_STATUS%"=="401" (
  echo [!] Local port %HERMES_PORT% is not enforcing the expected Uplink authentication gate.
  exit /b 1
)
exit /b 0

:validate_tunnel_uuid
set "UUID_VALID="
for /f "delims=" %%R in ('powershell -NoProfile -Command "$u=$env:TUNNEL_UUID; if($u -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'){ 'OK' }"') do set "UUID_VALID=%%R"
if /i not "%UUID_VALID%"=="OK" exit /b 1
exit /b 0

:ensure_cloudflared
if exist "bin\cloudflared.exe" (
  call :verify_cloudflared
  if errorlevel 1 (
    echo [!] Existing cloudflared binary is not the pinned release. Replacing it.
    del /f /q "bin\cloudflared.exe" >nul 2>&1
  )
)
if not exist "bin\cloudflared.exe" (
  if not exist bin mkdir bin
  echo [*] Downloading verified cloudflared %CLOUDFLARED_VERSION%, about 50MB, one time only...
  curl.exe --fail --location --proto "=https" --tlsv1.2 --silent --show-error -o "bin\cloudflared.exe" "%CLOUDFLARED_URL%"
  if errorlevel 1 ( echo [!] cloudflared download failed. & exit /b 1 )
)
if not exist "bin\cloudflared.exe" (
  echo [!] Download failed. Check internet access. & exit /b 1
)
call :verify_cloudflared
if errorlevel 1 (
  echo [!] cloudflared checksum verification failed. The file was removed.
  del /f /q "bin\cloudflared.exe" >nul 2>&1
  exit /b 1
)
exit /b 0

:verify_cloudflared
set "CLOUDFLARED_ACTUAL="
for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath 'bin\cloudflared.exe' -Algorithm SHA256).Hash"') do set "CLOUDFLARED_ACTUAL=%%H"
if /i "%CLOUDFLARED_ACTUAL%"=="%CLOUDFLARED_SHA256%" exit /b 0
exit /b 1
