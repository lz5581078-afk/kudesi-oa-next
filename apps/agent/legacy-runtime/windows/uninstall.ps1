param([switch]$RemoveProfiles, [switch]$RemoveProfilesConfirmed)

$ErrorActionPreference = "Stop"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\SessionManagerAgent"
$DataRoot = Join-Path $env:LOCALAPPDATA "KudesiSessionManagerAgent"
$TaskName = "Kudesi Session Manager Agent"
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($InstallRoot) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $InstallRoot -Recurse -Force -ErrorAction SilentlyContinue
if ($RemoveProfiles) {
  $Confirmation = if ($RemoveProfilesConfirmed) { 'DELETE' } else { Read-Host "将永久删除所有店铺 Profile、设备私钥和本机登录态。请输入 DELETE 确认" }
  if ($Confirmation -eq 'DELETE') { Remove-Item -LiteralPath $DataRoot -Recurse -Force -ErrorAction SilentlyContinue }
  else { Write-Host "未删除 Profile 数据。" -ForegroundColor Yellow }
} else {
  Write-Host "助手程序已卸载，店铺 Profile 和设备身份默认保留在：$DataRoot" -ForegroundColor Green
}
