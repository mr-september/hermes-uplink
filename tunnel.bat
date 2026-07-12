@echo off
REM =====================================================================
REM  hermes-uplink - OPTIONAL: expose over the internet via Cloudflare
REM ---------------------------------------------------------------------
REM  No Cloudflare account or signup needed. First run downloads a pinned,
REM  checksum-verified cloudflared binary to .\bin, then opens a "quick tunnel"
REM  to http://127.0.0.1:8787 and prints a public https URL.
REM  The passphrase gate protects it - the URL alone is not enough.
REM
REM  If your network blocks Cloudflare's tunnel port 7844, the tunnel uses
REM  --no-prechecks (set below) to skip the false egress pre-check.
REM =====================================================================
setlocal
cd /d "%~dp0"

if not exist ".uplink-pass.txt" (
  echo [!] Run launch.bat first so the passphrase exists.
  pause
  exit /b 1
)
set /p UPLINK_PASSPHRASE=<.uplink-pass.txt
if not defined UPLINK_PASSPHRASE (
  echo [!] Passphrase file is empty. Run launch.bat first.
  pause
  exit /b 1
)

set "CLOUDFLARED_VERSION=2026.7.0"
set "CLOUDFLARED_SHA256=b11ee950a12b15604e6b0a0f30a226516adc7aec75de2e3c642b28e50ddef9ea"
set "CLOUDFLARED_URL=https://github.com/cloudflare/cloudflared/releases/download/%CLOUDFLARED_VERSION%/cloudflared-windows-amd64.exe"

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
  if errorlevel 1 (
    echo [!] cloudflared download failed.
    pause
    exit /b 1
  )
)
if not exist "bin\cloudflared.exe" (
  echo [!] Download failed. Check internet access.
  pause
  exit /b 1
)
call :verify_cloudflared
if errorlevel 1 (
  echo [!] cloudflared checksum verification failed. The file was removed.
  del /f /q "bin\cloudflared.exe" >nul 2>&1
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Tunnel URL appears below. Share it together with the passphrase:
echo    Passphrase: %UPLINK_PASSPHRASE%
echo  URL alone is not enough, the passphrase gate is on.
echo ============================================================
echo.

if "%HERMES_PORT%"=="" set HERMES_PORT=8787
call "bin\cloudflared.exe" tunnel --no-prechecks --protocol http2 --url http://127.0.0.1:%HERMES_PORT%
pause
goto :eof

:verify_cloudflared
set "CLOUDFLARED_ACTUAL="
for /f "delims=" %%H in ('powershell -NoProfile -Command "(Get-FileHash -LiteralPath 'bin\cloudflared.exe' -Algorithm SHA256).Hash"') do set "CLOUDFLARED_ACTUAL=%%H"
if /i "%CLOUDFLARED_ACTUAL%"=="%CLOUDFLARED_SHA256%" exit /b 0
exit /b 1
