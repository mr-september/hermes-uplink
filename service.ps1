param(
    [ValidateSet("stop", "status")]
    [string]$Action,
    [int]$Port = 8787
)

$pidFile = Join-Path $PSScriptRoot ".uplink.pid"
if (-not (Test-Path -LiteralPath $pidFile)) {
    if ($Action -eq "status") { Write-Output "[!] Not running (run: launch_local.bat start)" }
    else { Write-Output "[!] Not running." }
    exit 1
}

$rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
[int]$targetPid = 0
if (-not [int]::TryParse($rawPid, [ref]$targetPid) -or $targetPid -le 0) {
    Write-Output "[!] Invalid Hermes Uplink pid file."
    exit 1
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId=$targetPid"
$commandLine = if ($process) { [string]$process.CommandLine } else { "" }
$scriptPattern = '(?i)(^|\s)["'']?proxy\.py["'']?(\s|$)'
$portPattern = '(?i)--port\s+["'']?' + [regex]::Escape([string]$Port) + '["'']?(\s|$)'
$isHermesProxy = $process -and
    $process.Name -match '^(pythonw?|py)(\.exe)?$' -and
    $commandLine -match $scriptPattern -and
    $commandLine -match $portPattern
if (-not $isHermesProxy) {
    if ($Action -eq "status") { Write-Output "[!] Not running (run: launch_local.bat start)" }
    else { Write-Output "[!] Refused to stop a process that was not identified as Hermes Uplink." }
    exit 1
}

if ($Action -eq "stop") {
    Stop-Process -Id $targetPid -Force
    Write-Output "[+] Stop signal sent."
} else {
    Write-Output "[+] Running on http://127.0.0.1:$Port"
}
