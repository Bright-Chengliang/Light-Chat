[CmdletBinding()]
param(
    [ValidateRange(3020, 4000)][int]$Port = 3020,
    [switch]$NoTrustProxy,
    [string]$AllowedHosts = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CredentialsFile = Join-Path $ProjectRoot '.secrets\credentials.dpapi.json'

if (-not (Test-Path -LiteralPath $CredentialsFile -PathType Leaf)) {
    throw '找不到 DPAPI 凭据。请先运行 scripts/configure-secrets.ps1。'
}

function Unprotect-Value {
    param([Parameter(Mandatory = $true)][string]$CipherText)
    $secure = ConvertTo-SecureString $CipherText
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secure.Dispose()
    }
}

$credentials = Get-Content -LiteralPath $CredentialsFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($credentials.version -ne 1) {
    throw '不支持的凭据文件版本。'
}

$env:CHAT_UPSTREAM_API_KEY = Unprotect-Value $credentials.newApiKey
$env:CHAT_BOOTSTRAP_USERNAME = [string]$credentials.username
$env:CHAT_BOOTSTRAP_PASSWORD = Unprotect-Value $credentials.initialPassword
$env:CHAT_SESSION_SECRET = Unprotect-Value $credentials.sessionSecret
$env:CHAT_PORT = [string]$Port
$env:CHAT_TRUST_PROXY = if ($NoTrustProxy) { 'false' } else { 'true' }
if ([string]::IsNullOrWhiteSpace($AllowedHosts)) {
    $AllowedHosts = [Environment]::GetEnvironmentVariable('CHAT_ALLOWED_HOSTS', 'Process')
}
if ([string]::IsNullOrWhiteSpace($AllowedHosts)) {
    $LocalHostsFile = Join-Path $ProjectRoot '.local\allowed-hosts'
    if (Test-Path -LiteralPath $LocalHostsFile) {
        $AllowedHosts = (Get-Content -LiteralPath $LocalHostsFile -Raw).Trim()
    }
}
if ([string]::IsNullOrWhiteSpace($AllowedHosts)) {
    $AllowedHosts = '127.0.0.1,localhost'
}
$env:CHAT_ALLOWED_HOSTS = $AllowedHosts
if (-not [Environment]::GetEnvironmentVariable('CHAT_UPSTREAM_BASE_URL', 'Process')) {
    $LocalUpstreamFile = Join-Path $ProjectRoot '.local\upstream-base-url'
    if (Test-Path -LiteralPath $LocalUpstreamFile) {
        $env:CHAT_UPSTREAM_BASE_URL = (Get-Content -LiteralPath $LocalUpstreamFile -Raw).Trim()
    }
}

try {
    Push-Location $ProjectRoot
    try {
        & node 'server.mjs'
        if ($LASTEXITCODE -ne 0) { throw "Node 服务退出，代码：$LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }
}
finally {
    Remove-Item Env:CHAT_UPSTREAM_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_BOOTSTRAP_USERNAME -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_SESSION_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_PORT -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_TRUST_PROXY -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_ALLOWED_HOSTS -ErrorAction SilentlyContinue
    Remove-Item Env:CHAT_UPSTREAM_BASE_URL -ErrorAction SilentlyContinue
    $credentials = $null
}
