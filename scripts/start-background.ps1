[CmdletBinding()]
param(
    [ValidateRange(3020, 4000)][int]$Port = 3020,
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$LogsDir = Join-Path $ProjectRoot '.logs'
$RunDir = Join-Path $ProjectRoot '.run'
$StartScript = Join-Path $PSScriptRoot 'start-server.ps1'

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Wait-PortFree([int]$TargetPort, [int]$TimeoutMs = 5000) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort $TargetPort -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return $false
}

$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
    if ($Restart) {
        $pidsToKill = @($listener.OwningProcess | Select-Object -Unique)
        $denied = $false
        foreach ($p in $pidsToKill) {
            try { Stop-Process -Id $p -Force -ErrorAction Stop }
            catch [Microsoft.PowerShell.Commands.ProcessCommandException] { }  # already exited
            catch { $denied = $true }
        }
        if (-not (Wait-PortFree $Port)) {
            # The running server was started elevated (e.g. by an elevated
            # shell or task); a non-elevated restart cannot stop it. Re-run this
            # script elevated instead of starting a second instance that would
            # only fail with EADDRINUSE.
            if ($denied -and -not (Test-IsElevated)) {
                Write-Host "当前服务进程以管理员权限运行，正在请求管理员权限以完成重启…"
                $elevated = Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -Wait -PassThru -ArgumentList @(
                    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Port', [string]$Port, '-Restart'
                )
                exit $elevated.ExitCode
            }
            throw "无法停止占用端口 $Port 的进程（PID: $($pidsToKill -join ', ')），重启已中止。"
        }
    } else {
        try {
            $health = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3
            if ($health.StatusCode -eq 200) { Write-Host "Light-Chat 已在 127.0.0.1:$Port 运行。"; exit 0 }
        } catch {}
        throw "端口 $Port 已被其他程序占用。"
    }
}

New-Item -ItemType Directory -Force -Path $LogsDir, $RunDir | Out-Null
$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $StartScript, '-Port', [string]$Port)
$process = Start-Process -FilePath 'pwsh.exe' -ArgumentList $arguments -WorkingDirectory $ProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogsDir 'server.out.log') -RedirectStandardError (Join-Path $LogsDir 'server.err.log') -PassThru
[IO.File]::WriteAllText((Join-Path $RunDir 'launcher.pid'), [string]$process.Id, [Text.UTF8Encoding]::new($false))
Write-Host "Light-Chat 后台启动器已创建，PID=$($process.Id)，端口=$Port。"
