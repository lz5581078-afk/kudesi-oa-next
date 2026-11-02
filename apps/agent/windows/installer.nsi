Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef PACKAGE_DIR
  !error "PACKAGE_DIR is required"
!endif
!ifndef PACKAGE_GLOB
  !error "PACKAGE_GLOB is required"
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
Name "酷得斯店铺助手"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
InstallDir "$LOCALAPPDATA\KudesiAssistant\app"
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "酷得斯店铺助手"
VIAddVersionKey /LANG=2052 "FileDescription" "酷得斯店铺助手安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Copyright (c) 2026"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TEXT "本向导将安装酷得斯店铺助手及桌面面板。$\r$\n$\r$\n请先在 OA 的“店铺提现 → 授权电脑”生成绑定码，稍后填写。安装会联网准备运行环境，请保持网络连接。$\r$\n$\r$\n店铺验证码及最终提现在平台后台人工完成。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
Var Args
Var Validate
Section "安装助手"
  StrCpy $INSTDIR "$LOCALAPPDATA\KudesiAssistant\app"
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${PACKAGE_GLOB}"
  ${GetParameters} $Args
  ClearErrors
  ${GetOptions} $Args "/VALIDATEONLY" $Validate
  ${IfNot} ${Errors}
    ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\setup.ps1" -ValidateOnly' $0
    ${If} $0 != 0
      SetErrorLevel $0
      Quit
    ${EndIf}
    ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\assistant-panel.ps1" -ValidateOnly' $0
    SetErrorLevel $0
    Quit
  ${EndIf}
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "助手需要64位 Windows。"
    SetErrorLevel 1
    Abort
  ${EndIf}
  DetailPrint "请在绑定窗口填写 OA 地址、绑定码和电脑名称。"
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -STA -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload\setup.ps1" -Installer' $0
  ${If} $0 != 0
    DetailPrint "安装已取消或未完成，未登记为安装成功。"
    SetErrorLevel $0
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant" "DisplayName" "酷得斯店铺助手"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant" "InstallLocation" "$INSTDIR"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant" "NoRepair" 1
SectionEnd
Section "Uninstall"
  SetShellVarContext current
  ExecWait '"$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\uninstall.ps1"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "卸载未完成，请关闭助手后重试。"
    SetErrorLevel $0
    Abort
  ${EndIf}
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiAssistant"
SectionEnd
