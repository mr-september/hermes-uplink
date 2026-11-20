param(
    [ValidateSet("start", "stop", "status")]
    [string]$Action,
    [int]$Port = 8787
)

# Start, stop, or report the Hermes Uplink proxy. A process is "the proxy" only when the pid file,
# the process name and command line, and a listener on $Port all agree — stop never kills an
# unrelated pid, and start never reports success on faith: it waits for those same checks to pass.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $PSScriptRoot -Parent
$pidFile = Join-Path $repoRoot ".uplink.pid"

function Get-UplinkProcess {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    [int]$targetPid = 0
    if (-not [int]::TryParse($rawPid, [ref]$targetPid) -or $targetPid -le 0) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid" -ErrorAction SilentlyContinue
    if (-not $process -or $process.Name -notmatch '^(pythonw?|py)(\.exe)?$') { return $null }
    if ([string]$process.CommandLine -notmatch '(?i)\s-m\s+uplink\.server(\s|$)') { return $null }
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $Port -OwningProcess $targetPid -ErrorAction SilentlyContinue)) { return $null }
    return $process
}

function Resolve-ProxyInterpreter {
    # Same resolution order as autostart.vbs, but every miss is reported instead of failing silently.
    if ($env:UPLINK_PYTHON) {
        if (-not (Test-Path -LiteralPath $env:UPLINK_PYTHON)) {
            Write-Output "[!] UPLINK_PYTHON is set but does not exist: $env:UPLINK_PYTHON"
            exit 1
        }
        $pythonw = Join-Path (Split-Path $env:UPLINK_PYTHON -Parent) "pythonw.exe"
        if (Test-Path -LiteralPath $pythonw) { return $pythonw }
        return $env:UPLINK_PYTHON   # the window is hidden either way
    }
    foreach ($name in "pythonw.exe", "python.exe") {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { return $command.Source }
    }
    Write-Output "[!] Python was not found: install it, add it to PATH, or set UPLINK_PYTHON."
    exit 1
}

switch ($Action) {
    "status" {
        if (Get-UplinkProcess) { Write-Output "[+] Running on http://127.0.0.1:$Port"; exit 0 }
        Write-Output "[!] Not running (run: launch_local.bat start)"
        exit 1
    }
    "stop" {
        if (Get-UplinkProcess) {
            Stop-Process -Id ([int](Get-Content -LiteralPath $pidFile -Raw).Trim()) -Force
            Write-Output "[+] Stop signal sent."
            exit 0
        }
        if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output "[!] Not running."; exit 1 }
        Write-Output "[!] Refused to stop a process that was not identified as Hermes Uplink."
        exit 1
    }
    "start" {
        if (Get-UplinkProcess) { Write-Output "[+] Already running on http://127.0.0.1:$Port"; exit 0 }
        $interpreter = Resolve-ProxyInterpreter
        $proxy = Start-Process -FilePath $interpreter -ArgumentList @("-m", "uplink.server") `
            -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline) {
            if (Get-UplinkProcess) { Write-Output "[+] Started on http://127.0.0.1:$Port"; exit 0 }
            if ($proxy.HasExited) {
                Write-Output "[!] The proxy exited immediately (code $($proxy.ExitCode)) with the port unbound; run 'python -m uplink.server' in a console to see the error."
                exit 1
            }
            Start-Sleep -Seconds 1
        }
        Write-Output "[!] The proxy did not become healthy on 127.0.0.1:$Port within 30 seconds."
        exit 1
    }
}
