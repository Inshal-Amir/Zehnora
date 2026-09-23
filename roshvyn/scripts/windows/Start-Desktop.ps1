<#
.SYNOPSIS
  Roshvyn Desktop on Windows: local MongoDB + LibreChat + connectors, then the Electron window.
  PowerShell equivalent of roshvyn/scripts/mac/start-desktop.sh. Run from the repository root:
    powershell -ExecutionPolicy Bypass -File roshvyn\scripts\windows\Start-Desktop.ps1 [-ServicesOnly]
  Prerequisites (listed honestly; not bundled): Git, Node 24.16.0, uv, MongoDB Community (mongod.exe),
  LibreChat built (npm ci; npm run frontend), connector envs (uv sync in roshvyn\connectors\*),
  roshvyn\desktop npm install. The API key is read from %APPDATA%\Roshvyn\secrets\roshvyn-api-key
  or supplied by the Electron shell (OS-encrypted storage).
  STATUS: written on the Mac, NOT yet run on Windows. Windows PowerShell/CMD behaviour must be tested on Windows.
#>
param([switch]$ServicesOnly, [string]$ApiBase = $(if ($env:ROSHVYN_API_BASE) { $env:ROSHVYN_API_BASE } else { 'http://127.0.0.1:8200/v1' }))

$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$R = Join-Path $Repo 'roshvyn'
$Data = if ($env:ROSHVYN_CLIENT_DATA) { $env:ROSHVYN_CLIENT_DATA } else { Join-Path $env:APPDATA 'Roshvyn' }
$Logs = Join-Path $Data 'logs'; $Run = Join-Path $Data 'run'; $Sec = Join-Path $Data 'secrets'
New-Item -ItemType Directory -Force -Path $Logs, $Run, $Sec, (Join-Path $Data 'mongo') | Out-Null
# Restrict the secrets folder to the current user.
icacls $Sec /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

function Say($m) { Write-Host "[$(Get-Date -Format HH:mm:ss)] $m" }
function Test-Port($p) { [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
function Wait-Http($url, $seconds = 120) {
  for ($i = 0; $i -lt $seconds; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url | Out-Null; return $true } catch { Start-Sleep 1 } }
  return $false
}
function New-Secret { -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) }) }

$Mongod = if ($env:MONGOD_BIN) { $env:MONGOD_BIN } else { (Get-Command mongod.exe -ErrorAction SilentlyContinue).Source }
if (-not $Mongod) { throw 'mongod.exe not found: install MongoDB Community Server or set MONGOD_BIN' }
if (-not (Test-Path (Join-Path $Repo 'client\dist\index.html'))) { throw "LibreChat UI not built: run 'npm ci' and 'npm run frontend' in $Repo" }

# One-time secrets
$envFile = Join-Path $Sec 'librechat.env'
if (-not (Test-Path $envFile)) {
  @("CREDS_KEY=$(New-Secret)", "CREDS_IV=$((New-Secret).Substring(0,32))", "JWT_SECRET=$(New-Secret)", "JWT_REFRESH_SECRET=$(New-Secret)") |
    Set-Content -Encoding ascii $envFile
}
$approvalSecret = Join-Path $Sec 'approval-secret'
if (-not (Test-Path $approvalSecret)) { New-Secret | Set-Content -Encoding ascii -NoNewline $approvalSecret }

# Workspace: the real Desktop known folder (follows OneDrive redirection) + Roshvyn-Workspace
$wsConfigDir = Join-Path $env:USERPROFILE '.roshvyn'; New-Item -ItemType Directory -Force -Path $wsConfigDir | Out-Null
$wsConfig = Join-Path $wsConfigDir 'workspace.json'
if (-not (Test-Path $wsConfig)) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  @{ workspace_root = (Join-Path $desktop 'Roshvyn-Workspace') } | ConvertTo-Json | Set-Content -Encoding utf8 $wsConfig
}

# Render librechat.yaml (Windows venv layout: .venv\Scripts\python.exe)
$fwd = { param($p) $p -replace '\\', '/' }
$yaml = Get-Content -Raw (Join-Path $R 'infra\client\librechat.yaml.template')
$yaml = $yaml.Replace('__REPO__/roshvyn/connectors/workspace/.venv/bin/python', (& $fwd "$R\connectors\workspace\.venv\Scripts\python.exe"))
$yaml = $yaml.Replace('__REPO__/roshvyn/connectors/search/.venv/bin/python', (& $fwd "$R\connectors\search\.venv\Scripts\python.exe"))
$yaml = $yaml.Replace('__REPO__', (& $fwd $Repo)).Replace('__WORKSPACE_CONFIG__', (& $fwd $wsConfig))
$yaml = $yaml.Replace('__CONNECTOR_DATA__', (& $fwd "$Data\workspace-connector")).Replace('__APPROVAL_URL__', 'http://127.0.0.1:3099/approve')
$yaml = $yaml.Replace('__APPROVAL_SECRET_FILE__', (& $fwd $approvalSecret)).Replace('__PLAYWRIGHT_BROWSERS__', (& $fwd "$Data\playwright-browsers"))
Set-Content -Encoding utf8 (Join-Path $Data 'librechat.yaml') $yaml

# 1. MongoDB (loopback)
if (-not (Test-Port 27028)) {
  $p = Start-Process -PassThru -WindowStyle Hidden $Mongod -ArgumentList @('--dbpath', "`"$Data\mongo`"", '--bind_ip', '127.0.0.1', '--port', '27028', '--logpath', "`"$Logs\mongod.log`"", '--logappend')
  $p.Id | Set-Content (Join-Path $Run 'mongod.pid'); Start-Sleep 3; Say 'mongod started on 127.0.0.1:27028'
} else { Say 'port 27028 already in use (assuming Roshvyn mongod)' }

# 2. LibreChat
if (-not (Test-Port 3090)) {
  Get-Content $envFile | ForEach-Object { $k, $v = $_ -split '=', 2; [Environment]::SetEnvironmentVariable($k, $v, 'Process') }
  $vars = @{ HOST = '127.0.0.1'; PORT = '3090'; DOMAIN_CLIENT = 'http://127.0.0.1:3090'; DOMAIN_SERVER = 'http://127.0.0.1:3090';
             MONGO_URI = 'mongodb://127.0.0.1:27028/RoshvynDesktop'; CONFIG_PATH = (Join-Path $Data 'librechat.yaml'); ENDPOINTS = 'agents,custom';
             SEARCH = 'false'; APP_TITLE = 'Roshvyn Desktop'; ALLOW_REGISTRATION = 'false'; ALLOW_SOCIAL_LOGIN = 'false';
             ALLOW_UNVERIFIED_EMAIL_LOGIN = 'true'; ROSHVYN_API_BASE = $ApiBase; NODE_ENV = 'production' }
  $vars.GetEnumerator() | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Key, $_.Value, 'Process') }
  if (-not $env:ROSHVYN_API_KEY) { $env:ROSHVYN_API_KEY = (Get-Content -Raw (Join-Path $Sec 'roshvyn-api-key')).Trim() }
  $p = Start-Process -PassThru -WindowStyle Hidden -WorkingDirectory $Repo node -ArgumentList @("`"$Repo\api\server\index.js`"") `
        -RedirectStandardOutput "$Logs\librechat.log" -RedirectStandardError "$Logs\librechat.err.log"
  $p.Id | Set-Content (Join-Path $Run 'librechat.pid')
  if (-not (Wait-Http 'http://127.0.0.1:3090/health')) { throw "LibreChat did not start (see $Logs)" }
  Say "LibreChat ready: http://127.0.0.1:3090 (model API: $ApiBase)"
} else { Say 'LibreChat port 3090 already in use (assuming running)' }

if (-not $ServicesOnly) {
  $env:ROSHVYN_CLIENT_DATA = $Data; $env:ROSHVYN_APPROVAL_SECRET_FILE = $approvalSecret; $env:ROSHVYN_WORKSPACE_CONFIG = $wsConfig
  $p = Start-Process -PassThru -WorkingDirectory (Join-Path $R 'desktop') (Join-Path $R 'desktop\node_modules\.bin\electron.cmd') -ArgumentList '.'
  $p.Id | Set-Content (Join-Path $Run 'electron.pid'); Say 'Roshvyn Desktop window starting'
}
