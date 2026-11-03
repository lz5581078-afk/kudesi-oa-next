param([switch]$InstallOnly, [switch]$Repair)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$AgentVersion = [string](Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\version.json") -Raw -Encoding UTF8 | ConvertFrom-Json).version
$DataRoot = Join-Path $env:LOCALAPPDATA "KudesiSessionManagerAgent"
$RuntimeParent = Join-Path $DataRoot "runtime"
$RuntimeRoot = Join-Path $RuntimeParent "chrome-for-testing"
$ChromeRoot = Join-Path $RuntimeRoot "chrome-win64"
$ChromeExe = Join-Path $ChromeRoot "chrome.exe"
$ManifestPath = Join-Path $RuntimeRoot "runtime-manifest.json"
$ChromeVersion = "151.0.7922.71"
$ChromeMajorVersion = 151
$ChromeArchive = "chrome-for-testing-win64-$ChromeVersion.zip"
$ChromeArchiveSha256 = "7ea2e94833ef710026c8cb08d0d2dafcb13f5d304d9c475ac07a3fa8c11d846c"
$ChromeUrls = @(
  "https://cdn.npmmirror.com/binaries/chrome-for-testing/$ChromeVersion/win64/chrome-win64.zip",
  "https://storage.googleapis.com/chrome-for-testing-public/$ChromeVersion/win64/chrome-win64.zip"
)
$CacheRoot = Join-Path $DataRoot "cache"
$LogRoot = Join-Path $DataRoot "logs"
$LogPath = Join-Path $LogRoot "browser-component.log"
$StatusPath = Join-Path $DataRoot "status.json"
$ArchivePath = Join-Path $CacheRoot $ChromeArchive
$StagingRoot = Join-Path $RuntimeParent "chrome-for-testing.staging-$PID"
$RollbackRoot = Join-Path $RuntimeParent "chrome-for-testing.rollback-$PID"

New-Item -ItemType Directory -Path $DataRoot, $RuntimeParent, $CacheRoot, $LogRoot -Force | Out-Null
$Created = $false
$Mutex = New-Object Threading.Mutex($true, "Local\KudesiSessionManagerChromeBootstrap", [ref]$Created)
if (-not $Created) { $Mutex.Dispose(); exit 0 }

function Write-Status {
  param([string]$State, [string]$Step, [int]$Progress, [string]$Message, [long]$Downloaded = 0, [long]$Total = 0)
  $Payload = [ordered]@{
    state = $State
    currentStep = $Step
    progress = [Math]::Max(0, [Math]::Min(100, $Progress))
    message = $Message
    component = "chrome_for_testing"
    bytesDownloaded = $Downloaded
    bytesTotal = $Total
    updatedAt = [DateTimeOffset]::Now.ToString("o")
  }
  $Temporary = "$StatusPath.$PID.tmp"
  [IO.File]::WriteAllText($Temporary, ($Payload | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $Temporary -Destination $StatusPath -Force
}

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

function Test-ManagedChrome([string]$Root) {
  try {
    $Exe = Join-Path $Root "chrome-win64\chrome.exe"
    $ManifestFile = Join-Path $Root "runtime-manifest.json"
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf) -or -not (Test-Path -LiteralPath $ManifestFile -PathType Leaf)) { return $false }
    $File = Get-Item -LiteralPath $Exe
    $Manifest = Get-Content -LiteralPath $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    return $File.Length -gt 1MB -and
      $File.VersionInfo.CompanyName -match "Google" -and
      ($File.VersionInfo.ProductName -match "Chrome" -or $File.VersionInfo.FileDescription -match "Chrome") -and
      [string]$Manifest.product -eq "chrome" -and
      [string]$Manifest.platform -eq "win64" -and
      [string]$Manifest.version -eq $ChromeVersion -and
      [string]$Manifest.archiveSha256 -eq $ChromeArchiveSha256 -and
      (Get-Sha256 $Exe) -eq [string]$Manifest.executableSha256
  } catch { return $false }
}

function Assert-CompatibleProfileMajor {
  $LastVersions = Get-ChildItem -LiteralPath (Join-Path $DataRoot "profiles") -Filter "Last Version" -Recurse -File -ErrorAction SilentlyContinue
  foreach ($File in $LastVersions) {
    $Value = [string](Get-Content -LiteralPath $File.FullName -Raw -ErrorAction SilentlyContinue)
    $Major = 0
    if ([int]::TryParse(($Value.Trim() -split '\.')[0], [ref]$Major) -and $ChromeMajorVersion -lt $Major) {
      throw "Chrome for Testing 主版本 $ChromeMajorVersion 低于现有 Profile 写入版本 $Value，已停止迁移。"
    }
  }
}

function Receive-ChromeArchive([string]$Url) {
  $Partial = "$ArchivePath.part"
  Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue
  $Request = [Net.HttpWebRequest]::Create($Url)
  $Request.Method = "GET"
  $Request.UserAgent = "KudesiSessionManagerAgent/$AgentVersion"
  $Request.Timeout = 60000
  $Request.ReadWriteTimeout = 60000
  $Response = $null
  $Input = $null
  $Output = $null
  try {
    $Response = $Request.GetResponse()
    $Total = [long]$Response.ContentLength
    $Input = $Response.GetResponseStream()
    $Output = [IO.File]::Open($Partial, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $Buffer = New-Object byte[] (1024 * 1024)
    $Downloaded = 0L
    while (($Read = $Input.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
      $Output.Write($Buffer, 0, $Read)
      $Downloaded += $Read
      $Fraction = if ($Total -gt 0) { $Downloaded / $Total } else { 0 }
      Write-Status "installing_components" "downloading" (5 + [int]($Fraction * 65)) "正在下载 Chrome for Testing" $Downloaded $Total
    }
    $Output.Flush()
  } finally {
    if ($Output) { $Output.Dispose() }
    if ($Input) { $Input.Dispose() }
    if ($Response) { $Response.Close() }
  }
  Move-Item -LiteralPath $Partial -Destination $ArchivePath -Force
}

function Install-ChromeForTesting {
  Assert-CompatibleProfileMajor
  if (-not $Repair -and (Test-ManagedChrome $RuntimeRoot)) {
    Write-Status "online" "browser_ready" 100 "Chrome for Testing $ChromeVersion 已安装"
    return
  }
  if (-not (Test-Path -LiteralPath $ArchivePath) -or (Get-Sha256 $ArchivePath) -ne $ChromeArchiveSha256) {
    Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
    $Failures = @()
    foreach ($Url in $ChromeUrls) {
      try { Receive-ChromeArchive $Url; break }
      catch { $Failures += $_.Exception.Message; Remove-Item -LiteralPath "$ArchivePath.part" -Force -ErrorAction SilentlyContinue }
    }
    if (-not (Test-Path -LiteralPath $ArchivePath)) { throw "Chrome for Testing 下载失败：$($Failures -join '；')" }
  }
  Write-Status "installing_components" "verifying_download" 72 "正在校验 Chrome for Testing 下载包"
  if ((Get-Sha256 $ArchivePath) -ne $ChromeArchiveSha256) {
    Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
    throw "Chrome for Testing 下载包 SHA-256 校验失败"
  }
  Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
  Write-Status "installing_components" "extracting" 78 "正在解压 Chrome for Testing"
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $StagingRoot -Force
  $StagedExe = Join-Path $StagingRoot "chrome-win64\chrome.exe"
  if (-not (Test-Path -LiteralPath $StagedExe -PathType Leaf)) { throw "下载内容不是 win64 chrome 产品" }
  $Info = (Get-Item -LiteralPath $StagedExe).VersionInfo
  if ($Info.CompanyName -notmatch "Google" -or ($Info.ProductName -notmatch "Chrome" -and $Info.FileDescription -notmatch "Chrome")) {
    throw "下载内容不是 Chrome for Testing 浏览器"
  }
  $ActualVersion = [string]$Info.ProductVersion
  if (($ActualVersion -split '\.')[0] -ne [string]$ChromeMajorVersion) { throw "Chrome for Testing 版本不匹配：$ActualVersion" }
  Write-Status "installing_components" "verifying_runtime" 90 "正在校验 Chrome for Testing 主程序"
  $Manifest = [ordered]@{
    product = "chrome"
    platform = "win64"
    version = $ChromeVersion
    actualVersion = $ActualVersion
    archiveSha256 = $ChromeArchiveSha256
    executableSha256 = Get-Sha256 $StagedExe
    installedAt = [DateTimeOffset]::Now.ToString("o")
  }
  [IO.File]::WriteAllText((Join-Path $StagingRoot "runtime-manifest.json"), ($Manifest | ConvertTo-Json -Depth 3), (New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath $RollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
  try {
    if (Test-Path -LiteralPath $RuntimeRoot) { Move-Item -LiteralPath $RuntimeRoot -Destination $RollbackRoot }
    Move-Item -LiteralPath $StagingRoot -Destination $RuntimeRoot
    if (-not (Test-ManagedChrome $RuntimeRoot)) { throw "专用 Chrome 安装后的完整性校验失败" }
    Remove-Item -LiteralPath $RollbackRoot -Recurse -Force -ErrorAction SilentlyContinue
  } catch {
    Remove-Item -LiteralPath $RuntimeRoot -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $RollbackRoot) { Move-Item -LiteralPath $RollbackRoot -Destination $RuntimeRoot }
    throw
  }
  Write-Status "online" "browser_ready" 100 "Chrome for Testing $ActualVersion 安装完成"
}

try {
  Start-Transcript -LiteralPath $LogPath -Append -Force | Out-Null
  Write-Status "installing_components" "preparing" 1 "正在准备 Chrome for Testing 组件"
  Install-ChromeForTesting
  exit 0
} catch {
  $Message = $_.Exception.Message
  Write-Status "error" "browser_component_failed" 100 "专用Chrome尚未安装或已损坏：$Message"
  Write-Error $Message
  exit 1
} finally {
  Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction SilentlyContinue
  try { Stop-Transcript | Out-Null } catch {}
  try { $Mutex.ReleaseMutex() } catch {}
  $Mutex.Dispose()
}
