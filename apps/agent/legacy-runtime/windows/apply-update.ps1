param(
  [Parameter(Mandatory = $true)][string]$JobId,
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedSha256,
  [Parameter(Mandatory = $true)][string]$TargetVersion,
  [ValidateSet('patch','component','full')][string]$PackageType = 'full',
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
$InstallRoot = Join-Path $env:LOCALAPPDATA "Programs\SessionManagerAgent"
$DataRoot = Join-Path $env:LOCALAPPDATA "KudesiSessionManagerAgent"
$ManagedWindowPath = Join-Path $DataRoot "managed-window.json"
$PendingPath = Join-Path $DataRoot "pending-update.json"
$StagingRoot = Join-Path $DataRoot "update-staging-$TargetVersion-$PID"
$CurrentApp = Join-Path $InstallRoot "app"
$RollbackRoot = Join-Path $InstallRoot "app.rollback"
$CurrentTray = Join-Path $InstallRoot 'windows\tray.ps1'
$RollbackTray = Join-Path $InstallRoot 'windows\tray.ps1.rollback'
$UpdaterVersion = (Get-Content -LiteralPath (Join-Path $InstallRoot "app\version.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
if ($UpdaterVersion -notmatch '^\d+\.\d+\.\d+$' -or $TargetVersion -notmatch '^\d+\.\d+\.\d+$') { throw "更新版本号无效。" }
function Write-JsonAtomic([string]$Path, [object]$Value) {
  $Temporary = "$Path.$PID.tmp"
  [IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $Temporary -Destination $Path -Force
}
function Write-Result([string]$Status, [string]$Phase, [string]$Message = '', [string]$FailureCode = '') {
  Write-JsonAtomic $ResultPath ([ordered]@{
    jobId = $JobId; status = $Status; phase = $Phase; errorMessage = $Message
    failureCode = $FailureCode; targetVersion = $TargetVersion; completedAt = [DateTimeOffset]::Now.ToString('o')
  })
}
if (Test-Path -LiteralPath $ManagedWindowPath) {
  $ManagedWindow = Get-Content -LiteralPath $ManagedWindowPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($ManagedWindow.pid -and (Get-Process -Id ([int]$ManagedWindow.pid) -ErrorAction SilentlyContinue)) {
    Write-JsonAtomic $PendingPath ([ordered]@{ status = "deferred"; targetVersion = $TargetVersion; packagePath = $PackagePath; sha256 = $ExpectedSha256; deferredAt = [DateTimeOffset]::Now.ToString('o') })
    Write-Result 'deferred' 'deferred' '受管店铺窗口仍在打开，更新已安全延期。'
    Write-Host "受管店铺窗口仍在打开，更新已安全延期。"; exit 75
  }
  Remove-Item -LiteralPath $ManagedWindowPath -Force -ErrorAction SilentlyContinue
}
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw "SHA-256 参数无效。" }
function Get-Sha256([string]$LiteralPath) {
  $Stream = [IO.File]::OpenRead($LiteralPath)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $Hash = $Hasher.ComputeHash($Stream)
    return ([BitConverter]::ToString($Hash)).Replace("-", "").ToLowerInvariant()
  } finally {
    $Stream.Dispose()
    $Hasher.Dispose()
  }
}

$ActualSha256 = Get-Sha256 $PackagePath
if ($ActualSha256 -ne $ExpectedSha256.ToLowerInvariant()) { throw "更新包 SHA-256 校验失败。" }
Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $PackagePath -DestinationPath $StagingRoot -Force
$PackageRoot = if (Test-Path -LiteralPath (Join-Path $StagingRoot "core-manifest.json")) {
  Get-Item -LiteralPath $StagingRoot
} else {
  Get-ChildItem -LiteralPath $StagingRoot -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "core-manifest.json") } | Select-Object -First 1
}
if (-not $PackageRoot) { throw "更新包缺少核心清单。" }
$Manifest = Get-Content -LiteralPath (Join-Path $PackageRoot.FullName "core-manifest.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]$Manifest.version -ne $TargetVersion) { throw "更新包版本不匹配。" }
$ReplacementApp = Join-Path $PackageRoot.FullName 'app'
if ($PackageType -in @('patch','component')) {
  $PatchManifestPath = Join-Path $PackageRoot.FullName 'patch-manifest.json'
  if (-not (Test-Path -LiteralPath $PatchManifestPath)) { throw '差分更新包缺少清单。' }
  $PatchManifest = Get-Content -LiteralPath $PatchManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$PatchManifest.fromVersion -ne $UpdaterVersion -or [string]$PatchManifest.targetVersion -ne $TargetVersion) { throw '差分更新版本范围不匹配。' }
  if ([int]$PatchManifest.updaterProtocol -ne 2) { throw '更新协议不兼容，需要人工修复。' }
  $OverlayApp = $ReplacementApp
  $ReplacementApp = Join-Path $PackageRoot.FullName 'app-final'
  Copy-Item -LiteralPath $CurrentApp -Destination $ReplacementApp -Recurse -Force
  $Allowed = @($PatchManifest.allowedFiles | ForEach-Object { [string]$_ })
  Get-ChildItem -LiteralPath $OverlayApp -File -Recurse | ForEach-Object {
    $Relative = ('app/' + $_.FullName.Substring($OverlayApp.Length).TrimStart('\').Replace('\','/'))
    if ($Allowed -notcontains $Relative) { throw "差分更新包含未授权文件：$Relative" }
    $Target = Join-Path $ReplacementApp $Relative.Substring(4).Replace('/','\')
    New-Item -ItemType Directory -Path (Split-Path $Target -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Force
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $ReplacementApp 'index.js'))) { throw "更新包缺少助手核心。" }
foreach ($Property in $Manifest.files.PSObject.Properties) {
  $Relative = [string]$Property.Name
  if (-not $Relative.StartsWith('app/')) { continue }
  $Candidate = Join-Path $ReplacementApp $Relative.Substring(4).Replace('/','\')
  if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf) -or (Get-Sha256 $Candidate) -ne [string]$Property.Value) {
    throw "更新后文件校验失败：$Relative"
  }
}
Stop-ScheduledTask -TaskName "Kudesi Session Manager Agent" -ErrorAction SilentlyContinue
$ManagedNode = Join-Path $CurrentApp 'runtime\node\node.exe'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessId -ne $PID -and $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $ManagedNode, [StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $RollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
try {
  Move-Item -LiteralPath $CurrentApp -Destination $RollbackRoot
  Move-Item -LiteralPath $ReplacementApp -Destination $CurrentApp
  $UpdatedTray = Join-Path $CurrentApp 'windows\tray.ps1'
  if (Test-Path -LiteralPath $UpdatedTray -PathType Leaf) {
    Copy-Item -LiteralPath $CurrentTray -Destination $RollbackTray -Force
    Copy-Item -LiteralPath $UpdatedTray -Destination $CurrentTray -Force
  }
  [IO.File]::WriteAllText((Join-Path $InstallRoot "agent-version.txt"), $TargetVersion, (New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath $PendingPath -Force -ErrorAction SilentlyContinue
  Write-Result 'succeeded' 'restarting'
  Start-ScheduledTask -TaskName "Kudesi Session Manager Agent"
  Write-Result 'succeeded' 'restarting'
  Remove-Item -LiteralPath $RollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $RollbackTray -Force -ErrorAction SilentlyContinue
} catch {
  Remove-Item -LiteralPath $CurrentApp -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $RollbackRoot) { Move-Item -LiteralPath $RollbackRoot -Destination $CurrentApp }
  if (Test-Path -LiteralPath $RollbackTray) { Move-Item -LiteralPath $RollbackTray -Destination $CurrentTray -Force }
  Start-ScheduledTask -TaskName "Kudesi Session Manager Agent" -ErrorAction SilentlyContinue
  Write-Result 'failed' 'applying' '更新失败，已恢复旧版本。' 'apply_failed'
  throw
} finally { Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue }
