# 卸载助手：停止并删除开机任务、删除程序。店铺的浏览器 Profile（登录状态）默认保留，加 -RemoveData 一并删除。
param([switch]$RemoveData)
$ErrorActionPreference = 'Continue'
Stop-ScheduledTask -TaskName 'KudesiAssistant' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'KudesiAssistant' -Confirm:$false -ErrorAction SilentlyContinue
$root = Join-Path $env:LOCALAPPDATA 'KudesiAssistant'
Remove-Item -Recurse -Force (Join-Path $root 'app') -ErrorAction SilentlyContinue
if ($RemoveData) { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue; Write-Host '已删除程序和本机全部数据（包括店铺登录状态）。' }
else { Write-Host '已卸载程序。店铺登录状态仍保留在本机；要一并删除请加 -RemoveData。OA 里这台电脑也请点“撤销”。' }
