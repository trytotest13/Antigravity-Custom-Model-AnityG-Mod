# AnityG Mod - direct dashboard launcher.
# Makes sure the proxy is running (starts it if not), then opens the
# model dashboard in the default browser. Used by open-dashboard.bat
# and the "AnityG Dashboard" desktop shortcut.
$ErrorActionPreference = 'SilentlyContinue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$data = Join-Path $env:USERPROFILE '.gemini\antigravity'
$portFile = Join-Path $data 'active_port'

function Test-Proxy([string]$p) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:$p/api/models"
        return ($null -ne $r -and $r.StatusCode -lt 500)
    } catch { return $false }
}

$port = $null
if (Test-Path $portFile) {
    $t = (Get-Content $portFile -Raw).Trim()
    if ($t -match '^\d+$' -and (Test-Proxy $t)) { $port = $t }
}
if (-not $port -and (Test-Proxy 50999)) { $port = 50999 }

if (-not $port) {
    # Proxy down (e.g. after reboot): start it hidden, same logging as deploy-ide.ps1
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Remove-Item $portFile -Force -ErrorAction SilentlyContinue
    Start-Process node -ArgumentList "`"$here\proxy-standalone.js`"" -WorkingDirectory $here -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $data 'proxy.log') -RedirectStandardError (Join-Path $data 'proxy.err.log')
    for ($i = 0; $i -lt 30 -and -not $port; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-Path $portFile) {
            $t = (Get-Content $portFile -Raw).Trim()
            if ($t -match '^\d+$' -and (Test-Proxy $t)) { $port = $t }
        }
    }
}

if (-not $port) {
    Write-Host "[ERROR] AnityG proxy did not start - check $data\proxy.err.log"
    exit 1
}
Start-Process "http://127.0.0.1:$port/dashboard"
