param([switch]$Tray, [switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$root = Join-Path $env:LOCALAPPDATA 'KudesiAssistant'
$appRoot = Join-Path $root 'app'
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex = New-Object Threading.Mutex($false, "Local\KudesiAssistantPanel-$sid")
$wake = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, "Local\KudesiAssistantPanelWake-$sid")
$quit = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::AutoReset, "Local\KudesiAssistantPanelQuit-$sid")
if (-not $mutex.WaitOne(0)) { [void]$wake.Set(); $wake.Dispose(); $quit.Dispose(); $mutex.Dispose(); exit }
$form = New-Object Windows.Forms.Form
$form.Text = '酷得斯店铺助手'; $form.ClientSize = New-Object Drawing.Size(580, 350)
$form.StartPosition = 'CenterScreen'; $form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$status = New-Object Windows.Forms.Label
$status.SetBounds(24, 12, 530, 160)
$hint = New-Object Windows.Forms.Label
$hint.SetBounds(24, 270, 530, 64)
$hint.Text = '先在 OA 分配店铺，再点“立即登录”。验证码、短信和提现操作在店铺窗口人工完成；本机登录环境与公司店铺维护相互独立。'
function Read-Json($file) { if (Test-Path -LiteralPath $file) { try { return Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }; return $null }
function Refresh-Status {
  $cfg = Read-Json (Join-Path $root 'agent.json')
  $s = Read-Json (Join-Path $root 'status.json')
  $state = Read-Json (Join-Path $appRoot 'update-state.json')
  $remote = Read-Json (Join-Path $root 'remote.json')
  $policy = if ($remote.policy) { $remote.policy } else { 'off' }
  $status.Text = "电脑：$($cfg.name)`r`n设备号：$($cfg.deviceNo)`r`nOA：$($cfg.serverUrl)`r`n版本：$($state.current)`r`n状态：$($s.message)`r`n最后更新：$($s.at)`r`n远程协助：$policy"
}
function Node-Exe {
  $local = Join-Path $appRoot 'runtime\node.exe'
  if (Test-Path -LiteralPath $local) { return $local }
  $cmd = Get-Command node -ErrorAction Stop
  return $cmd.Source
}
function Button($text, $x, $y, $action) {
  $button = New-Object Windows.Forms.Button
  $button.Text = $text; $button.SetBounds($x, $y, 164, 34)
  $button.Add_Click($action); $form.Controls.Add($button)
}
Button '打开店铺提现' 24 178 {
  try {
    $cfg = Read-Json (Join-Path $root 'agent.json'); $uri = [Uri]$cfg.serverUrl
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'OA 地址无效，请重新安装绑定。' }
    Start-Process ($cfg.serverUrl.TrimEnd('/') + '/finance/doc-withdrawal')
  } catch { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message) }
}
Button '启动助手' 202 178 { try { Start-ScheduledTask -TaskName 'KudesiAssistant'; Refresh-Status } catch { [void][Windows.Forms.MessageBox]::Show('启动失败，请重新安装助手。') } }
Button '停止助手' 380 178 {
  if ([Windows.Forms.MessageBox]::Show('停止后该电脑不能接收店铺任务，正在使用的店铺窗口可能关闭。确认停止？','停止助手','YesNo') -eq 'Yes') { Stop-ScheduledTask -TaskName 'KudesiAssistant' -ErrorAction SilentlyContinue; $status.Text = '已发送停止请求，请到 OA 核对电脑离线状态。' }
}
Button '查看日志' 24 220 { $file=Join-Path $root 'agent.log'; if (Test-Path -LiteralPath $file) { Start-Process notepad.exe -ArgumentList @("`"$file`"") } }
Button '远程每次询问' 202 220 {
  try { $s=Read-Json (Join-Path $appRoot 'update-state.json'); $entry=Join-Path $appRoot "versions\$($s.current)\dist\cli.js"; & (Node-Exe) $entry remote prompt | Out-Null; if ($LASTEXITCODE -ne 0) { throw '设置失败' }; Refresh-Status } catch { [void][Windows.Forms.MessageBox]::Show('设置失败，请查看日志。') }
}
Button '关闭远程协助' 380 220 {
  try { $s=Read-Json (Join-Path $appRoot 'update-state.json'); $entry=Join-Path $appRoot "versions\$($s.current)\dist\cli.js"; & (Node-Exe) $entry remote off | Out-Null; if ($LASTEXITCODE -ne 0) { throw '设置失败' }; Refresh-Status } catch { [void][Windows.Forms.MessageBox]::Show('设置失败，请查看日志。') }
}
$form.Controls.AddRange(@($status, $hint))
if ($ValidateOnly) { $form.Dispose(); $wake.Dispose(); $quit.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose(); return }
$icon = New-Object Windows.Forms.NotifyIcon
$icon.Icon = [Drawing.SystemIcons]::Application; $icon.Text = '酷得斯店铺助手'; $icon.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$show = $menu.Items.Add('显示助手面板'); $show.Add_Click({ $form.Show(); $form.WindowState='Normal'; $form.Activate() })
$exit = $menu.Items.Add('退出面板（助手继续运行）'); $exit.Add_Click({ $script:closing=$true; $form.Close() })
$icon.ContextMenuStrip = $menu
$icon.Add_DoubleClick({ $form.Show(); $form.WindowState='Normal'; $form.Activate() })
$script:closing = $false
$form.Add_FormClosing({ param($sender, $eventArgs) if (-not $script:closing) { $eventArgs.Cancel=$true; $form.Hide() } })
$form.Add_Shown({ if ($Tray) { $form.Hide() } })
$timer = New-Object Windows.Forms.Timer
$timer.Interval=5000
$timer.Add_Tick({ if ($quit.WaitOne(0)) { $script:closing=$true; $form.Close(); return }; Refresh-Status; if ($wake.WaitOne(0)) { $form.Show(); $form.WindowState='Normal'; $form.Activate() } })
try { Refresh-Status; $timer.Start(); [Windows.Forms.Application]::Run($form) }
finally { $timer.Stop(); $timer.Dispose(); $icon.Dispose(); $quit.Dispose(); $wake.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }
