[CmdletBinding()]
param([ValidateRange(3020, 4000)][int]$Port = 3020)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$LogsDir = Join-Path $ProjectRoot '.logs'
$RunDir = Join-Path $ProjectRoot '.run'
$StartScript = Join-Path $PSScriptRoot 'start-server.ps1'

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
    try {
        $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
        if ($health.StatusCode -eq 200) { Write-Host "Light-Chat 已在 127.0.0.1:$Port 运行。"; exit 0 }
    } catch {}
    throw "端口 $Port 已被其他程序占用。"
}

New-Item -ItemType Directory -Force -Path $LogsDir, $RunDir | Out-Null
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $StartScript, '-Port', [string]$Port)
$process = Start-Process -FilePath 'pwsh.exe' -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir 'server.out.log') -RedirectStandardError (Join-Path $LogsDir 'server.err.log') -PassThru
[IO.File]::WriteAllText((Join-Path $RunDir 'launcher.pid'), [string]$process.Id, [Text.UTF8Encoding]::new($false))
Write-Host "Light-Chat 后台启动器已创建，PID=$($process.Id)，端口=$Port。"
