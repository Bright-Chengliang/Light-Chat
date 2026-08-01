[CmdletBinding()]
param(
    [string]$PreferencesFile = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($PreferencesFile)) {
    $PreferencesFile = Join-Path $ProjectRoot '.data\preferences.json'
}
$BackupFile = "$PreferencesFile.bak"

if (-not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
    throw "找不到备份文件：$BackupFile"
}
if (-not (Test-Path -LiteralPath $PreferencesFile -PathType Leaf)) {
    throw "找不到当前配置文件：$PreferencesFile"
}

$current = Get-Content -LiteralPath $PreferencesFile -Raw -Encoding UTF8 | ConvertFrom-Json
$backup = Get-Content -LiteralPath $BackupFile -Raw -Encoding UTF8 | ConvertFrom-Json
$backupIds = @($backup.favoriteMediaIds)
$currentIds = @($current.favoriteMediaIds)

if ($currentIds.Count -gt 0 -or $backupIds.Count -eq 0) {
    Write-Host '当前收藏列表不为空，或备份中没有可恢复的收藏记录，无需恢复。'
    exit 0
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item -LiteralPath $PreferencesFile -Destination "$PreferencesFile.pre-restore-$timestamp.json" -Force
$current.favoriteMediaIds = $backupIds
$json = $current | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($PreferencesFile, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

Write-Host "已从备份恢复 $($backupIds.Count) 条收藏图片记录。"
Write-Host "恢复前文件已保存为：$PreferencesFile.pre-restore-$timestamp.json"
