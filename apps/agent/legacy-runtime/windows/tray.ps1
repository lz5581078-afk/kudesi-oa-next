$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
if (-not ('Kudesi.NativeIcon' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace Kudesi {
  public static class NativeIcon {
    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DestroyIcon(IntPtr handle);
  }
}
'@
}
$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\SessionManagerAgent"
$DataRoot = Join-Path $env:LOCALAPPDATA "KudesiSessionManagerAgent"
$ConfigPath = Join-Path $DataRoot "agent.json"
$StatusPath = Join-Path $DataRoot "status.json"
$NodeExe = Join-Path $InstallRoot "app\runtime\node\node.exe"
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { throw "助手内置 Node.js 运行时缺失。" }
$BootstrapPath = Join-Path $InstallRoot "app\windows\bootstrap.ps1"
$ProgressPath = Join-Path $InstallRoot "app\windows\component-progress.ps1"
$Created = $false
$Mutex = New-Object Threading.Mutex($true, "KudesiSessionManagerAgentTray", [ref]$Created)
if (-not $Created) { exit 0 }
function Read-Json([string]$Path) { try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null } }
function Start-Core { Start-Process -FilePath $NodeExe -ArgumentList @((Join-Path $InstallRoot "app\index.js")) -WorkingDirectory (Join-Path $InstallRoot "app") -WindowStyle Hidden }
function Pair-Device {
  $Server = [Microsoft.VisualBasic.Interaction]::InputBox("请输入 OA 地址（https://...）", "绑定电脑", "https://lc.kudesi.com/")
  if (-not $Server) { return }
  $Code = [Microsoft.VisualBasic.Interaction]::InputBox("请输入网页生成的 8 位一次性绑定码", "绑定电脑")
  if (-not $Code) { return }
  $env:SESSION_MANAGER_SERVER_URL = $Server; $env:SESSION_MANAGER_PAIRING_CODE = $Code
  try {
    $Process = Start-Process -FilePath $NodeExe -ArgumentList @((Join-Path $InstallRoot "app\register-device.js")) -WorkingDirectory (Join-Path $InstallRoot "app") -WindowStyle Hidden -Wait -PassThru
    if ($Process.ExitCode -eq 0) { Start-Core; [Windows.Forms.MessageBox]::Show("电脑绑定成功。", "多店铺登录助手") | Out-Null }
    else { [Windows.Forms.MessageBox]::Show("电脑绑定失败，请检查 OA 地址和绑定码。", "多店铺登录助手") | Out-Null }
  } finally { Remove-Item Env:SESSION_MANAGER_SERVER_URL, Env:SESSION_MANAGER_PAIRING_CODE -ErrorAction SilentlyContinue }
}
function Repair-Browser {
  Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$BootstrapPath,'-InstallOnly','-Repair') -WindowStyle Hidden
  Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$ProgressPath)
}
function Invoke-UpdateCommand([string]$Mode) {
  $Arguments = @((Join-Path $InstallRoot 'app\update-cli.js'))
  if ($Mode -eq 'request') { $Arguments += '--request' }
  Start-Process -FilePath $NodeExe -ArgumentList $Arguments -WorkingDirectory (Join-Path $InstallRoot 'app') -WindowStyle Hidden
}
function New-StatusBitmap([string]$ColorName) {
  $Colors = @{ green = '#22A06B'; blue = '#1976D2'; orange = '#E58A00'; gray = '#8492A6'; red = '#D14343' }
  $Bitmap = New-Object Drawing.Bitmap 16, 16
  $Graphics = [Drawing.Graphics]::FromImage($Bitmap)
  try {
    $Graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $Brush = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($Colors[$ColorName]))
    try { $Graphics.FillEllipse($Brush, 1, 1, 14, 14) } finally { $Brush.Dispose() }
    $Inner = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
    try { $Graphics.FillEllipse($Inner, 6, 6, 4, 4) } finally { $Inner.Dispose() }
  } finally { $Graphics.Dispose() }
  return $Bitmap
}
function New-StatusIcon([string]$ColorName) {
  $Bitmap = $null
  $Handle = [IntPtr]::Zero
  try {
    $Bitmap = New-StatusBitmap $ColorName
    $Handle = $Bitmap.GetHicon()
    return [Drawing.Icon]::FromHandle($Handle).Clone()
  } catch {
    return New-Object Drawing.Icon([Drawing.SystemIcons]::Application, 16, 16)
  } finally {
    if ($Handle -ne [IntPtr]::Zero) { [void][Kudesi.NativeIcon]::DestroyIcon($Handle) }
    if ($Bitmap) { $Bitmap.Dispose() }
  }
}
$VersionPath = Join-Path $InstallRoot 'app\version.json'
$Version = Read-Json $VersionPath
$Menu = New-Object Windows.Forms.ContextMenuStrip
$StatusItem = New-Object Windows.Forms.ToolStripMenuItem "状态：正在读取"; $StatusItem.Enabled = $false
$CurrentVersionItem = New-Object Windows.Forms.ToolStripMenuItem "当前版本：v$([string]$Version.version)"; $CurrentVersionItem.Enabled = $false
$LatestVersionItem = New-Object Windows.Forms.ToolStripMenuItem "线上最新版本：正在获取"; $LatestVersionItem.Enabled = $false
$VersionConclusionItem = New-Object Windows.Forms.ToolStripMenuItem "正在检查版本"; $VersionConclusionItem.Enabled = $false
$TaskItem = New-Object Windows.Forms.ToolStripMenuItem "当前任务：当前无任务"; $TaskItem.Enabled = $false
$LastConnectedItem = New-Object Windows.Forms.ToolStripMenuItem "最后连接 OA：-"; $LastConnectedItem.Enabled = $false
$PairItem = New-Object Windows.Forms.ToolStripMenuItem "绑定这台电脑"
$CheckUpdateItem = New-Object Windows.Forms.ToolStripMenuItem "检查更新"
$UpdateNowItem = New-Object Windows.Forms.ToolStripMenuItem "立即更新"; $UpdateNowItem.Visible = $false
$RestartItem = New-Object Windows.Forms.ToolStripMenuItem "重启助手"
$RepairItem = New-Object Windows.Forms.ToolStripMenuItem "修复浏览器组件"
$ExitItem = New-Object Windows.Forms.ToolStripMenuItem "退出托盘"
[void]$Menu.Items.Add($StatusItem); [void]$Menu.Items.Add($CurrentVersionItem); [void]$Menu.Items.Add($LatestVersionItem)
[void]$Menu.Items.Add($VersionConclusionItem); [void]$Menu.Items.Add($TaskItem); [void]$Menu.Items.Add($LastConnectedItem)
[void]$Menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator)); [void]$Menu.Items.Add($PairItem)
[void]$Menu.Items.Add($CheckUpdateItem); [void]$Menu.Items.Add($UpdateNowItem); [void]$Menu.Items.Add($RestartItem)
[void]$Menu.Items.Add($RepairItem); [void]$Menu.Items.Add($ExitItem)
$PairItem.Add_Click({ Pair-Device }); $CheckUpdateItem.Add_Click({ Invoke-UpdateCommand 'check' })
$UpdateNowItem.Add_Click({ Invoke-UpdateCommand 'request' }); $RestartItem.Add_Click({ Start-Core }); $RepairItem.Add_Click({ Repair-Browser })
$CurrentColor = 'gray'
$Icon = New-StatusIcon $CurrentColor
$Notify = New-Object System.Windows.Forms.NotifyIcon
$Notify.Icon = $Icon; $Notify.Text = "酷得斯多店铺登录助手"; $Notify.ContextMenuStrip = $Menu; $Notify.Visible = $true
$ExitItem.Add_Click({ $Notify.Visible = $false; [Windows.Forms.Application]::Exit() })
$Timer = New-Object Windows.Forms.Timer; $Timer.Interval = 2000
$Timer.Add_Tick({
  $State = Read-Json $StatusPath; $Config = Read-Json $ConfigPath; $PairItem.Visible = (-not $Config) -or (-not $Config.deviceToken)
  if ((-not $Config) -or (-not $Config.deviceToken)) {
    $StatusItem.Text = '状态：助手尚未绑定'; $NextColor = 'gray'
  } elseif ($State) {
    $StatusItem.Text = "状态：$([string]$State.displayState)"
    if ([int]$State.progress -gt 0 -and [int]$State.progress -lt 100) { $StatusItem.Text += " · $([int]$State.progress)%" }
    $NextColor = if (@('green','blue','orange','gray','red') -contains [string]$State.color) { [string]$State.color } else { 'gray' }
  } else { $StatusItem.Text = '状态：正在连接 OA'; $NextColor = 'gray' }
  if ($NextColor -ne $CurrentColor) {
    $NewIcon = New-StatusIcon $NextColor; $Notify.Icon = $NewIcon; $Icon.Dispose(); $Icon = $NewIcon; $CurrentColor = $NextColor
  }
  $CurrentVersionItem.Text = "当前版本：v$([string]$Version.version)"
  $LatestVersionItem.Text = if ($State -and $State.latestVersion) { "线上最新版本：v$([string]$State.latestVersion)" } else { '线上最新版本：无法获取' }
  $VersionConclusionItem.Text = if ($State -and $State.versionConclusion) { [string]$State.versionConclusion } else { '无法获取线上版本' }
  $TaskItem.Text = if ($State -and $State.taskName) { '当前任务：{0} - {1}' -f ([string]$State.displayState), ([string]$State.taskName) } else { '当前任务：当前无任务' }
  if ($State -and $State.lastConnectedAt) {
    $ConnectedAt = ([DateTime]$State.lastConnectedAt).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
    $LastConnectedItem.Text = "最后连接 OA：$ConnectedAt"
  } else { $LastConnectedItem.Text = '最后连接 OA：-' }
  $UpdateNowItem.Visible = [bool]($State -and $State.updateAvailable)
})
$Timer.Start()
try { [Windows.Forms.Application]::Run() } finally { $Timer.Dispose(); $Notify.Dispose(); $Icon.Dispose(); try { $Mutex.ReleaseMutex() } catch {}; $Mutex.Dispose() }
