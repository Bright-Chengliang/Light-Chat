[CmdletBinding()]
param(
    [string]$Serial = 'emulator-5554',
    [string]$Apk = '',
    [string]$Adb = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$adbCandidates = @()
if ($Adb) { $adbCandidates += $Adb }
if ($env:MUMU_ADB) { $adbCandidates += $env:MUMU_ADB }
$LocalAdbFile = Join-Path $ProjectRoot '.local\mumu-adb'
if (Test-Path -LiteralPath $LocalAdbFile) {
    $adbCandidates += (Get-Content -LiteralPath $LocalAdbFile -Raw).Trim()
}
$adbCandidates += (Join-Path ($env:ANDROID_HOME ?? (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) 'platform-tools\adb.exe')
$adb = $adbCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $adb) { throw '找不到 ADB。请启动 MuMu 或设置 ANDROID_HOME。' }
if (-not $Apk) { $Apk = Join-Path $ProjectRoot 'output\android\Light-Chat-1.0.0-debug.apk' }
if (-not (Test-Path -LiteralPath $Apk)) { throw "找不到 APK：$Apk。请先运行 scripts/build-android.ps1。" }

& $adb devices | Out-Host
& $adb -s $Serial install -r (Resolve-Path -LiteralPath $Apk).Path
if ($LASTEXITCODE -ne 0) { throw "APK 安装失败，退出码：$LASTEXITCODE" }
& $adb -s $Serial shell am start -W -n top.brightcl.lightchat.debug/top.brightcl.lightchat.MainActivity
Write-Host "已安装并启动 Light-Chat Android（$Serial）。"
