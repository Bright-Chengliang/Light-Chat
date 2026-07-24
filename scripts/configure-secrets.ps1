[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SecretsDir = Join-Path $ProjectRoot '.secrets'
$CredentialsFile = Join-Path $SecretsDir 'credentials.dpapi.json'

function Read-SecretValue {
    param(
        [Parameter(Mandatory = $true)][string]$EnvironmentName,
        [Parameter(Mandatory = $true)][string]$Prompt
    )

    $plain = [Environment]::GetEnvironmentVariable($EnvironmentName, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($plain)) {
        try {
            return ConvertTo-SecureString $plain -AsPlainText -Force
        }
        finally {
            [Environment]::SetEnvironmentVariable($EnvironmentName, $null, 'Process')
            $plain = $null
        }
    }
    return Read-Host $Prompt -AsSecureString
}

function Reveal-SecureValue {
    param([Parameter(Mandatory = $true)][Security.SecureString]$Value)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$username = [Environment]::GetEnvironmentVariable('CHAT_SETUP_USERNAME', 'Process')
if ([string]::IsNullOrWhiteSpace($username)) {
    $username = Read-Host '管理员用户名'
}
[Environment]::SetEnvironmentVariable('CHAT_SETUP_USERNAME', $null, 'Process')
if ($username -notmatch '^[A-Za-z0-9_.-]{3,64}$') {
    throw '用户名需为 3–64 位字母、数字、点、下划线或连字符。'
}

$apiKey = Read-SecretValue -EnvironmentName 'CHAT_SETUP_NEWAPI_API_KEY' -Prompt 'NewAPI 专用 API 密钥'
$initialPassword = Read-SecretValue -EnvironmentName 'CHAT_SETUP_INITIAL_PASSWORD' -Prompt '管理员初始密码（至少 10 个字符）'
$passwordCheck = Reveal-SecureValue $initialPassword
try {
    if ($passwordCheck.Length -lt 10 -or $passwordCheck.Length -gt 256) {
        throw '管理员初始密码需为 10–256 个字符。'
    }
}
finally {
    $passwordCheck = $null
}

$sessionBytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($sessionBytes)
$sessionSecret = ConvertTo-SecureString ([Convert]::ToBase64String($sessionBytes)) -AsPlainText -Force
[Array]::Clear($sessionBytes, 0, $sessionBytes.Length)

New-Item -ItemType Directory -Path $SecretsDir -Force | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$directoryAcl = [Security.AccessControl.DirectorySecurity]::new()
$directoryAcl.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    $propagation,
    [Security.AccessControl.AccessControlType]::Allow
)
$directoryAcl.AddAccessRule($rule)
Set-Acl -LiteralPath $SecretsDir -AclObject $directoryAcl

$payload = [ordered]@{
    version = 1
    username = $username
    newApiKey = ConvertFrom-SecureString $apiKey
    initialPassword = ConvertFrom-SecureString $initialPassword
    sessionSecret = ConvertFrom-SecureString $sessionSecret
    createdAt = [DateTimeOffset]::Now.ToString('o')
}
$json = $payload | ConvertTo-Json -Depth 3
[IO.File]::WriteAllText($CredentialsFile, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
$fileAcl = [Security.AccessControl.FileSecurity]::new()
$fileAcl.SetAccessRuleProtection($true, $false)
$fileRule = [Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
)
$fileAcl.AddAccessRule($fileRule)
Set-Acl -LiteralPath $CredentialsFile -AclObject $fileAcl

$apiKey.Dispose()
$initialPassword.Dispose()
$sessionSecret.Dispose()
$json = $null
$payload = $null

Write-Host "DPAPI 凭据已保存到受限目录：$CredentialsFile"
Write-Host '明文密钥和初始密码未写入源码或配置文件。'
