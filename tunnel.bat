@echo off
REM =====================================================================
REM  hermes-uplink - OPTIONAL: expose over the internet via Cloudflare
REM ---------------------------------------------------------------------
REM  No Cloudflare account or signup needed. First run downloads the
REM  portable cloudflared binary to .\bin, then opens a "quick tunnel"
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

if not exist "bin\cloudflared.exe" (
  if not exist bin mkdir bin
  echo [*] Downloading cloudflared portable, about 50MB, one time only...
  curl.exe -L -o "bin\cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
)
if not exist "bin\cloudflared.exe" (
  echo [!] Download failed. Check internet access.
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

call "bin\cloudflared.exe" tunnel --no-prechecks --protocol http2 --url http://127.0.0.1:8787
pause
