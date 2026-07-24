[CmdletBinding()]
param(
    [ValidateSet('debug', 'release')][string]$BuildType = 'debug',
    [string]$BaseUrl = 'https://chat.example.com/'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$AndroidRoot = Join-Path $ProjectRoot 'android'
$SdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$JavaRoot = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'C:\Program Files\Android\Android Studio\jbr' }

if (-not (Test-Path -LiteralPath (Join-Path $AndroidRoot 'gradlew.bat'))) { throw '找不到 Android Gradle Wrapper，请先检查 android 工程。' }
if (-not (Test-Path -LiteralPath $SdkRoot)) { throw "找不到 Android SDK：$SdkRoot" }
if (-not (Test-Path -LiteralPath (Join-Path $JavaRoot 'bin\java.exe'))) { throw "找不到 JDK：$JavaRoot" }

$uri = [Uri]$BaseUrl
if ($uri.Scheme -ne 'https' -or [string]::IsNullOrWhiteSpace($uri.Host) -or $uri.UserInfo -or ($uri.Port -notin @(-1, 443))) {
    throw 'BaseUrl 必须是无用户信息、标准 HTTPS 端口的绝对地址。'
}

$env:ANDROID_HOME = $SdkRoot
$env:JAVA_HOME = $JavaRoot
$task = "testDebugUnitTest", "lintDebug", "assemble$($BuildType.Substring(0, 1).ToUpperInvariant())$($BuildType.Substring(1))"
Push-Location $AndroidRoot
try {
    & .\gradlew.bat @task "-PLIGHT_CHAT_BASE_URL=$BaseUrl"
    if ($LASTEXITCODE -ne 0) { throw "Android 构建失败，退出码：$LASTEXITCODE" }
}
finally { Pop-Location }

$apk = Join-Path $AndroidRoot "app\build\outputs\apk\$BuildType\app-$BuildType.apk"
if (-not (Test-Path -LiteralPath $apk)) { throw "构建完成但找不到 APK：$apk" }
$artifactDir = Join-Path $ProjectRoot 'output\android'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$artifact = Join-Path $artifactDir "Light-Chat-1.0.0-$BuildType.apk"
Copy-Item -LiteralPath $apk -Destination $artifact -Force
Write-Host "Android APK：$artifact"
