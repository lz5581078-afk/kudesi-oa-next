param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$TargetVersion
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$InstallRoot = Join-Path $env:LOCALAPPDATA 'Programs\SessionManagerAgent'
$DataRoot = Join-Path $env:LOCALAPPDATA 'KudesiSessionManagerAgent'
$RepairRoot = Join-Path $DataRoot ("repair-0.3.0-" + [Guid]::NewGuid().ToString('N'))
$ExtractRoot = Join-Path $RepairRoot 'package'
$ResultPath = Join-Path $RepairRoot 'repair-result.json'
$JobId = [Guid]::NewGuid().ToString()
$TaskName = "Kudesi Session Manager Agent Update $JobId"

function Get-Sha256([string]$LiteralPath) {
  $Stream = [IO.File]::OpenRead($LiteralPath); $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
  finally { $Stream.Dispose(); $Hasher.Dispose() }
}

if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw '请选择完整应用更新 ZIP。' }
if ((Get-Sha256 $PackagePath) -ne $ExpectedSha256.ToLowerInvariant()) { throw '修复包 SHA-256 校验失败。' }
New-Item -ItemType Directory -Path $ExtractRoot -Force | Out-Null
Expand-Archive -LiteralPath $PackagePath -DestinationPath $ExtractRoot -Force
$PackageRoot = if (Test-Path -LiteralPath (Join-Path $ExtractRoot 'app\windows\apply-update.ps1')) {
  Get-Item -LiteralPath $ExtractRoot
} else {
  Get-ChildItem -LiteralPath $ExtractRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'app\windows\apply-update.ps1') } | Select-Object -First 1
}
if (-not $PackageRoot) { throw '更新 ZIP 缺少新版独立更新器。' }
$Updater = Join-Path $RepairRoot 'apply-update.ps1'
Copy-Item -LiteralPath (Join-Path $PackageRoot.FullName 'app\windows\apply-update.ps1') -Destination $Updater -Force
$Arguments = @(
  '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$Updater`"",
  '-JobId',$JobId,'-PackagePath',"`"$PackagePath`"",'-ExpectedSha256',$ExpectedSha256,
  '-TargetVersion',$TargetVersion,'-PackageType','full','-ResultPath',"`"$ResultPath`""
) -join ' '
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments
$Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
[Windows.Forms.MessageBox]::Show('修复更新已启动。升级完成后，OA 将通过新版助手心跳确认结果。', '酷得斯多店铺登录助手') | Out-Null
