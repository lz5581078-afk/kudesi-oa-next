param(
  [Parameter(Mandatory = $true)][string]$JobId,
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$TargetVersion,
  [ValidateSet('patch','component','full')][string]$PackageType = 'full'
)

$ErrorActionPreference = 'Stop'
if ($JobId -notmatch '^[a-fA-F0-9-]{36}$') { throw '更新任务编号无效。' }
$DataRoot = Join-Path $env:LOCALAPPDATA 'KudesiSessionManagerAgent'
$UpdateRoot = Join-Path $DataRoot 'updates'
$JobRoot = Join-Path $UpdateRoot $JobId
$InstalledUpdater = Join-Path $env:LOCALAPPDATA 'Programs\SessionManagerAgent\app\windows\apply-update.ps1'
$Updater = Join-Path $JobRoot 'apply-update.ps1'
$ResultPath = Join-Path $UpdateRoot 'update-result.json'
$TaskName = "Kudesi Session Manager Agent Update $JobId"
New-Item -ItemType Directory -Path $JobRoot -Force | Out-Null
Copy-Item -LiteralPath $InstalledUpdater -Destination $Updater -Force
$Arguments = @(
  '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Updater`"",
  '-JobId', $JobId, '-PackagePath', "`"$PackagePath`"", '-ExpectedSha256', $ExpectedSha256,
  '-TargetVersion', $TargetVersion, '-PackageType', $PackageType, '-ResultPath', "`"$ResultPath`""
) -join ' '
$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
$Principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
