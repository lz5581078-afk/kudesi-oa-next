param([switch]$ValidateOnly, [switch]$Installer)
# Windows 安装入口：不读取/嵌入 OA 员工密码，绑定码仅在本次安装中使用。
$ErrorActionPreference = 'Stop'
$script:installed = $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = '酷得斯店铺助手 · 安装与绑定'
$form.ClientSize = New-Object Drawing.Size(520, 330)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
function Field($text, $top, $value) {
  $label = New-Object Windows.Forms.Label
  $label.Text = $text; $label.SetBounds(24, $top, 140, 24)
  $box = New-Object Windows.Forms.TextBox
  $box.Text = $value; $box.SetBounds(168, $top, 326, 28)
  $form.Controls.AddRange(@($label, $box))
  return $box
}
$server = Field 'OA 地址' 26 'https://lc.kudesi.com'
$code = Field '一次性绑定码' 76 ''
$code.MaxLength = 8
$name = Field '电脑名称' 126 $env:COMPUTERNAME
$hint = New-Object Windows.Forms.Label
$hint.Text = '先到 OA“店铺提现 → 授权电脑”生成绑定码。安装会联网准备运行环境；登录状态仅保存在这台电脑。'
$hint.SetBounds(24, 174, 470, 58)
$install = New-Object Windows.Forms.Button
$install.Text = '安装并绑定'; $install.SetBounds(332, 258, 160, 40)
$install.Add_Click({
  if ($code.Text.Trim() -notmatch '^[A-HJ-NP-Z2-9]{8}$') { [Windows.Forms.MessageBox]::Show('请填写 OA 生成的 8 位绑定码。'); return }
  $install.Enabled = $false; $hint.Text = '正在安装，请在打开的安装窗口查看进度；完成前请勿关闭窗口。'
  $form.Refresh()
  try {
    & (Join-Path $PSScriptRoot 'install.ps1') -Server $server.Text.Trim() -Code $code.Text.Trim().ToUpperInvariant() -Name $name.Text.Trim()
    $script:installed = $true
    $code.Clear()
    [Windows.Forms.MessageBox]::Show('安装及绑定成功，助手已启动。请回 OA 确认电脑显示在线。') | Out-Null
    $form.Close()
  } catch {
    $code.Clear(); $hint.Text = '安装未完成，请检查网络后使用新的绑定码重试。'
    [Windows.Forms.MessageBox]::Show($_.Exception.Message, '安装未完成') | Out-Null
  } finally { $install.Enabled = $true }
})
$form.Controls.AddRange(@($hint, $install))
if ($ValidateOnly) { $form.Dispose(); return }
[void]$form.ShowDialog()

if ($Installer -and -not $script:installed) { exit 2 }
