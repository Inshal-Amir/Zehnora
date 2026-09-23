<#
.SYNOPSIS
  Zehnora GPU PC preflight (Windows PowerShell). Inspects Windows, GPU/driver, WSL2, Docker Desktop, disk, RAM and ports.
  Makes no changes. Run in a normal (non-admin) PowerShell window:
    powershell -ExecutionPolicy Bypass -File zehnora\scripts\windows\Preflight.ps1
  Add -GpuContainerTest to run a short CUDA container that prints nvidia-smi (downloads a small image).
  STATUS: written on the Mac, NOT yet run on Windows. Record the first real output in docs/STATUS.md.
#>
param([switch]$GpuContainerTest)

$ErrorActionPreference = 'Continue'
$results = @()
function Add-Result($Name, $Ok, $Detail) {
  $script:results += [pscustomobject]@{ Check = $Name; Status = $(if ($Ok) { 'OK' } else { 'CHECK' }); Detail = $Detail }
}

# Windows
$os = Get-CimInstance Win32_OperatingSystem
Add-Result 'Windows' ([version]$os.Version -ge [version]'10.0.19044') "$($os.Caption) $($os.Version)"

# CPU / RAM
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name
$ramGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
Add-Result 'CPU' $true $cpu
Add-Result 'RAM (GB)' ($ramGB -ge 32) "$ramGB"

# Disk (system drive and every fixed drive)
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  $free = [math]::Round($_.FreeSpace / 1GB, 1)
  Add-Result "Disk $($_.DeviceID) free (GB)" ($free -ge 60) "$free of $([math]::Round($_.Size / 1GB, 0))"
}

# NVIDIA GPU + driver (Windows side; WSL uses this driver - do not install Linux display drivers in WSL)
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  $gpu = & nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>&1
  Add-Result 'NVIDIA GPU' ($LASTEXITCODE -eq 0) "$gpu"
} else {
  Add-Result 'NVIDIA GPU' $false 'nvidia-smi not found: install/update the NVIDIA Windows driver'
}

# WSL2
$wslStatus = (wsl.exe --status 2>&1 | Out-String) -replace "`0", ''
Add-Result 'WSL installed' ($LASTEXITCODE -eq 0) (($wslStatus -split "`n" | Select-Object -First 2) -join ' ').Trim()
$distros = (wsl.exe -l -v 2>&1 | Out-String) -replace "`0", ''
Add-Result 'WSL distros (need VERSION 2)' ($distros -match '\s2\s*$' -or $distros -match '\s2\r?$') ($distros.Trim() -replace '\s+', ' ')

# Docker Desktop (Linux engine via WSL2)
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
  $info = & docker info --format '{{.OperatingSystem}} | {{.ServerVersion}} | runtimes: {{json .Runtimes}}' 2>&1
  Add-Result 'Docker engine' ($LASTEXITCODE -eq 0) "$info"
  if ($GpuContainerTest -and $LASTEXITCODE -eq 0) {
    $gpuTest = & docker run --rm --gpus all nvidia/cuda:12.9.1-base-ubuntu24.04 nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>&1
    Add-Result 'GPU inside a container' ($LASTEXITCODE -eq 0) "$gpuTest"
  }
} else {
  Add-Result 'Docker engine' $false 'docker CLI not found: install Docker Desktop and enable the WSL2 backend'
}

# Ports used by the Zehnora server profile (nginx on 127.0.0.1:8080)
foreach ($port in 8080) {
  $busy = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  Add-Result "Port $port free" (-not $busy) $(if ($busy) { "in use by PID $($busy[0].OwningProcess)" } else { 'free' })
}

# Power: sleep must be off while hosting (report only; change it yourself with awareness)
$ac = (powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1 | Select-String 'Current AC Power Setting Index').ToString()
Add-Result 'Sleep on AC (0x00000000 = never)' ($ac -match '0x00000000') $ac.Trim()

$results | Format-Table -AutoSize
$results | ConvertTo-Json | Out-File -Encoding utf8 (Join-Path $PSScriptRoot 'preflight-result.json')
Write-Host "Saved preflight-result.json next to this script. 'CHECK' rows need attention before deployment."
