[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$escapedRoot = [Regex]::Escape($ProjectRoot)
$processes = @(Get-CimInstance Win32_Process)
$launchers = @($processes | Where-Object {
    $_.CommandLine -and $_.Name -match '^pwsh(?:\.exe)?$' -and
    $_.CommandLine -match $escapedRoot -and $_.CommandLine -match 'start-server\.ps1'
})
$launcherIds = @($launchers | ForEach-Object ProcessId)
$servers = @($processes | Where-Object {
    $_.CommandLine -and $_.Name -match '^node(?:\.exe)?$' -and $_.CommandLine -match 'server\.mjs' -and (
        $_.CommandLine -match $escapedRoot -or $launcherIds -contains $_.ParentProcessId
    )
})
$targets = @($servers) + @($launchers)

foreach ($target in $targets) {
    Stop-Process -Id $target.ProcessId -Force -ErrorAction SilentlyContinue
}
Write-Host "已停止 $($targets.Count) 个 Light-Chat 相关进程。"
