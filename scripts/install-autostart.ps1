[CmdletBinding()]
param([ValidateRange(3020, 4000)][int]$Port = 3020)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$StartScript = Join-Path $PSScriptRoot 'start-background.ps1'
$TaskName = 'ChatOnline-LocalService'
$User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$argument = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$StartScript`" -Port $Port"
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument $argument -WorkingDirectory $ProjectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Starts the local authenticated ChatOnline service on loopback.' -Force | Out-Null
Write-Host "已注册登录自启动任务：$TaskName（127.0.0.1:$Port）。"
