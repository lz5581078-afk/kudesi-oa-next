param([switch]$InstallAndWait)

$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\SessionManagerAgent"
$DataRoot = Join-Path $env:LOCALAPPDATA "KudesiSessionManagerAgent"
$StatusPath = Join-Path $DataRoot "status.json"
$BootstrapPath = Join-Path $InstallRoot "app\windows\bootstrap.ps1"

function Read-Status { try { Get-Content -LiteralPath $StatusPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null } }
function Start-Repair {
  return Start-Process -FilePath "powershell.exe" -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$BootstrapPath,'-InstallOnly','-Repair') -WindowStyle Hidden -PassThru
}

$Form = New-Object Windows.Forms.Form
$Form.Text = "多店铺登录助手 · 浏览器组件"
$Form.StartPosition = "CenterScreen"
$Form.ClientSize = New-Object Drawing.Size(520, 250)
$Form.Font = New-Object Drawing.Font("Microsoft YaHei UI", 9)
$Title = New-Object Windows.Forms.Label
$Title.Location = New-Object Drawing.Point(24, 20); $Title.Size = New-Object Drawing.Size(470, 30); $Title.Font = New-Object Drawing.Font("Microsoft YaHei UI", 14, [Drawing.FontStyle]::Bold)
$Title.Text = "Chrome for Testing 组件状态"
$Progress = New-Object Windows.Forms.ProgressBar
$Progress.Location = New-Object Drawing.Point(26, 67); $Progress.Size = New-Object Drawing.Size(468, 24); $Progress.Minimum = 0; $Progress.Maximum = 100
$Detail = New-Object Windows.Forms.Label
$Detail.Location = New-Object Drawing.Point(26, 103); $Detail.Size = New-Object Drawing.Size(468, 65)
$Repair = New-Object Windows.Forms.Button
$Repair.Location = New-Object Drawing.Point(26, 188); $Repair.Size = New-Object Drawing.Size(142, 34); $Repair.Text = "修复浏览器组件"; $Repair.Add_Click({ $Repair.Enabled = $false; $script:BootstrapProcess = Start-Repair })
$Close = New-Object Windows.Forms.Button
$Close.Location = New-Object Drawing.Point(384, 188); $Close.Size = New-Object Drawing.Size(110, 34); $Close.Text = "后台运行"; $Close.Add_Click({ $Form.Close() })
$Form.Controls.AddRange(@($Title,$Progress,$Detail,$Repair,$Close))

function Update-State {
  $State = Read-Status
  if (-not $State) { $Detail.Text = "尚未读取到组件状态。"; return }
  $Progress.Value = [Math]::Max(0, [Math]::Min(100, [int]$State.progress))
  $Bytes = if ($State.bytesTotal -and [long]$State.bytesTotal -gt 0) { "`r`n已下载 $([Math]::Round([long]$State.bytesDownloaded / 1MB, 1)) MB / $([Math]::Round([long]$State.bytesTotal / 1MB, 1)) MB" } else { "" }
  $Detail.Text = "$([int]$State.progress)% · $([string]$State.message)$Bytes"
  $Repair.Enabled = [string]$State.state -ne "installing_components"
  if ($InstallAndWait -and $script:BootstrapProcess -and $script:BootstrapProcess.HasExited) {
    if ([string]$State.state -eq "online" -and $script:BootstrapProcess.ExitCode -eq 0) {
      $script:InstallExitCode = 0
      $Form.Close()
    } elseif ([string]$State.state -eq "error" -or $script:BootstrapProcess.ExitCode -ne 0) {
      $script:InstallExitCode = 1
      $Close.Text = "关闭"
      $Close.Enabled = $true
    }
  }
}
$script:InstallExitCode = if ($InstallAndWait) { 1 } else { 0 }
$script:BootstrapProcess = $null
$Form.Add_Shown({
  if ($InstallAndWait) {
    $Repair.Visible = $false
    $Close.Enabled = $false
    $script:BootstrapProcess = Start-Repair
  }
})
$Timer = New-Object Windows.Forms.Timer; $Timer.Interval = 700; $Timer.Add_Tick({ Update-State }); $Timer.Start(); Update-State
try { [void]$Form.ShowDialog() } finally { $Timer.Dispose(); $Form.Dispose() }
exit $script:InstallExitCode
