# 酷得斯店铺登录助手 - 安装 / 重新安装（在要登录店铺的那台 Windows 电脑上运行，不需要管理员权限）
# 用法：右键 PowerShell 运行   .\install.ps1 -Server https://oa.你的域名 -Code 绑定码
# 目录结构（支持在线自动升级）：
#   %LOCALAPPDATA%\KudesiAssistant\app\launcher.js          启动器（开机任务运行它，升级不会改它）
#   %LOCALAPPDATA%\KudesiAssistant\app\versions\<版本>\...   各版本程序（升级时新增，旧版本保留一份用于回退）
#   %LOCALAPPDATA%\KudesiAssistant\app\update-state.json     当前版本 / 上一版本 / 是否试运行
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Code,
  [string]$Name = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw '没有找到 Node.js。请先安装 Node.js 20 或更高版本（https://nodejs.org），再重新运行本脚本。' }
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { throw "Node.js 版本太低（当前 $major），需要 20 或更高。" }

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:LOCALAPPDATA 'KudesiAssistant\app'
$version = (Get-Content -Raw -Encoding UTF8 (Join-Path $src 'package.json') | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '安装包里的版本号不对。' }

# 重新安装前先停掉正在运行的助手和启动器
Stop-ScheduledTask -TaskName 'KudesiAssistant' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

New-Item -ItemType Directory -Force -Path $dest | Out-Null
$vdir = Join-Path $dest "versions\$version"
if (Test-Path $vdir) { Remove-Item -Recurse -Force $vdir }
New-Item -ItemType Directory -Force -Path $vdir | Out-Null
Copy-Item -Recurse -Force (Join-Path $src 'dist') $vdir
Copy-Item -Force (Join-Path $src 'package.json') $vdir
Copy-Item -Force (Join-Path $src 'package.json') $dest      # npm install 在根目录装依赖，各版本共用
Copy-Item -Force (Join-Path $src 'launcher.js') $dest
Push-Location $dest
try { & npm install --omit=dev --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm install 失败，请检查网络。' } } finally { Pop-Location }

# 启动状态：当前版本 = 刚装的版本，没有试运行
$state = [ordered]@{ current = $version; previous = $null; trial = $false; bad = @() } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $dest 'update-state.json'), $state, (New-Object Text.UTF8Encoding($false)))
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $dest 'healthy.json'), (Join-Path $dest 'update-result.json')
# 清掉旧布局（1.0.0 把程序直接放在 app\dist）
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $dest 'dist')

# 绑定这台电脑（绑定码 10 分钟有效、只能用一次）
$env:KUDESI_AGENT_ROOT = $dest
& node (Join-Path $vdir 'dist\cli.js') register --server $Server --code $Code --name $Name
if ($LASTEXITCODE -ne 0) { throw '绑定失败，请回到 OA 重新生成绑定码。' }

# 开机（登录后）自动启动启动器，隐藏窗口
$nodePath = $node.Source
$action = New-ScheduledTaskAction -Execute $nodePath -Argument "`"$dest\launcher.js`"" -WorkingDirectory $dest
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 0)
Register-ScheduledTask -TaskName 'KudesiAssistant' -Action $action -Trigger $trigger -Settings $settings -Description '酷得斯 OA 店铺登录助手' -Force | Out-Null
[Environment]::SetEnvironmentVariable('KUDESI_AGENT_ROOT', $dest, 'User')   # 手动运行 cli.js status 时也能找到安装目录
Start-ScheduledTask -TaskName 'KudesiAssistant'
Write-Host "安装完成：助手 $version 已启动，之后每次登录 Windows 会自动运行，并可在 OA 里一键升级。"
Write-Host '查看状态：node "$dest\versions\<版本>\dist\cli.js" status      日志：%LOCALAPPDATA%\KudesiAssistant\agent.log 和 app\launcher.log'
