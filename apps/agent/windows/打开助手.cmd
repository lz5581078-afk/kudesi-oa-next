@echo off
powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\KudesiAssistant\app\assistant-panel.ps1"
if errorlevel 1 pause
