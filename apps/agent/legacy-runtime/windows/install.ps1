param([string]$ServerUrl = "", [string]$PairingCode = "")

$ErrorActionPreference = "Stop"
$PackageRoot = Split-Path $PSScriptRoot -Parent
$Version = [string](Get-Content -LiteralPath (Join-Path $PackageRoot "app\version.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "助手版本号无效。" }
$BundledNodeExe = Join-Path $PackageRoot "app\runtime\node\node.exe"
if (-not (Test-Path -LiteralPath $BundledNodeExe -PathType Leaf)) { throw "安装包缺少内置 Node.js 运行时。" }
$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\SessionManagerAgent"
$DataRoot = Join-Path $env:LOCALAPPDATA "KudesiSessionManagerAgent"
$StagingRoot = "$InstallRoot.staging-$PID"
$BackupRoot = "$InstallRoot.rollback"
$TaskName = "Kudesi Session Manager Agent"

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($InstallRoot)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $StagingRoot, $DataRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PackageRoot "app") -Destination (Join-Path $StagingRoot "app") -Recurse -Force
Copy-Item -LiteralPath $PSScriptRoot -Destination (Join-Path $StagingRoot "windows") -Recurse -Force
[IO.File]::WriteAllText((Join-Path $StagingRoot "agent-version.txt"), $Version, (New-Object Text.UTF8Encoding($false)))
$InstalledNodeExe = Join-Path $InstallRoot "app\runtime\node\node.exe"
$StartScript = @"
`$InstallRoot = '$($InstallRoot.Replace("'", "''"))'
`$NodeExe = '$($InstalledNodeExe.Replace("'", "''"))'
Start-Process -FilePath `$NodeExe -ArgumentList @((Join-Path `$InstallRoot 'app\index.js')) -WorkingDirectory (Join-Path `$InstallRoot 'app') -WindowStyle Hidden
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',(Join-Path `$InstallRoot 'windows\tray.ps1')) -WindowStyle Hidden
"@
[IO.File]::WriteAllText((Join-Path $StagingRoot "start-agent.ps1"), $StartScript, (New-Object Text.UTF8Encoding($true)))
& icacls.exe $DataRoot /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" | Out-Null

Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
$HadPreviousInstall = Test-Path -LiteralPath $InstallRoot
try {
  if ($HadPreviousInstall) { Move-Item -LiteralPath $InstallRoot -Destination $BackupRoot }
  Move-Item -LiteralPath $StagingRoot -Destination $InstallRoot
  $ProgressScript = Join-Path $InstallRoot "app\windows\component-progress.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ProgressScript -InstallAndWait
  if ($LASTEXITCODE -ne 0) { throw "专用Chrome尚未安装或已损坏" }
  $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$InstallRoot\start-agent.ps1`""
  $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Force | Out-Null
  if ($ServerUrl -and $PairingCode) {
    $env:SESSION_MANAGER_SERVER_URL = $ServerUrl
    $env:SESSION_MANAGER_PAIRING_CODE = $PairingCode
    try { & $InstalledNodeExe (Join-Path $InstallRoot "app\register-device.js") } finally {
      Remove-Item Env:SESSION_MANAGER_SERVER_URL, Env:SESSION_MANAGER_PAIRING_CODE -ErrorAction SilentlyContinue
    }
  }
  Start-ScheduledTask -TaskName $TaskName
  Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "酷得斯多店铺登录助手 V$Version 安装完成。店铺 Profile 数据位于 $DataRoot。" -ForegroundColor Green
} catch {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $BackupRoot) {
    Move-Item -LiteralPath $BackupRoot -Destination $InstallRoot
    Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  throw
} finally {
  Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
}
