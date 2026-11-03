$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$Filter = "Name = 'chrome.exe' OR Name = 'chromium.exe' OR Name = 'chrome-headless-shell.exe'"
$Processes = @(Get-CimInstance -ClassName Win32_Process -Filter $Filter -ErrorAction Stop | ForEach-Object {
  [ordered]@{
    name = [string]$_.Name
    pid = [int]$_.ProcessId
    executablePath = [string]$_.ExecutablePath
    commandLine = [string]$_.CommandLine
  }
})
[ordered]@{ complete = $true; processes = $Processes } | ConvertTo-Json -Depth 4 -Compress
