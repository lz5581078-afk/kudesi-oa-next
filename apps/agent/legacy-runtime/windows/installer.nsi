Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !error "VERSION is required"
!endif
!ifndef PACKAGE_DIR
  !error "PACKAGE_DIR is required"
!endif
!ifndef OUTPUT_DIR
  !error "OUTPUT_DIR is required"
!endif

!define PRODUCT_NAME "酷得斯多店铺登录助手"
!define INSTALL_ROOT "$LOCALAPPDATA\Programs\SessionManagerAgent"
!ifdef UNSIGNED_TEST
  !define PRODUCT_CAPTION "${PRODUCT_NAME}（未签名测试版）"
!else
  !define PRODUCT_CAPTION "${PRODUCT_NAME}"
!endif

Name "${PRODUCT_CAPTION}"
Caption "${PRODUCT_CAPTION} ${VERSION}"
!ifdef OFFLINE_CHROME_ARCHIVE
  !ifndef OFFLINE_CHROME_FILENAME
    !error "OFFLINE_CHROME_FILENAME is required with OFFLINE_CHROME_ARCHIVE"
  !endif
  OutFile "${OUTPUT_DIR}\KudesiSessionManagerAgent-Offline-Setup-${VERSION}.exe"
!else
  OutFile "${OUTPUT_DIR}\KudesiSessionManagerAgent-Setup-${VERSION}.exe"
!endif
InstallDir "${INSTALL_ROOT}"
RequestExecutionLevel user
; Solid LZMA saves little here because Node and sidecar are already compressed,
; but it makes every release rebuild substantially slower.
SetCompressor /FINAL lzma
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "山东优冠种业有限公司"
VIAddVersionKey /LANG=2052 "FileDescription" "酷得斯多店铺登录助手安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装酷得斯多店铺登录助手"
!define MUI_WELCOMEPAGE_TEXT "安装程序将自动安装助手运行环境、Chrome for Testing、托盘程序和开机启动。无需安装 Node.js，也无需执行任何命令。$\r$\n$\r$\n覆盖安装和卸载默认保留店铺 Profile、本机登录态和设备身份。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "安装助手" MainSection
  SetShellVarContext current
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\KudesiSessionManagerAgent"
  SetOutPath "$PLUGINSDIR\KudesiSessionManagerAgent"
  File /r "${PACKAGE_DIR}\*"
  !ifdef OFFLINE_CHROME_ARCHIVE
    File /oname=${OFFLINE_CHROME_FILENAME} "${OFFLINE_CHROME_ARCHIVE}"
    CreateDirectory "$LOCALAPPDATA\KudesiSessionManagerAgent\cache"
    CopyFiles /SILENT "$PLUGINSDIR\KudesiSessionManagerAgent\${OFFLINE_CHROME_FILENAME}" "$LOCALAPPDATA\KudesiSessionManagerAgent\cache\${OFFLINE_CHROME_FILENAME}"
  !endif
  DetailPrint "正在安装助手和浏览器组件..."
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\KudesiSessionManagerAgent\windows\install.ps1"' $0
  ${If} $0 != 0
    RMDir /r "$PLUGINSDIR\KudesiSessionManagerAgent"
    MessageBox MB_ICONSTOP "安装未完成，原有助手和店铺 Profile 已保留。请截图错误信息并联系管理员。"
    SetErrorLevel $0
    Abort
  ${EndIf}
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent" "Publisher" "山东优冠种业有限公司"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent" "NoRepair" 1
  RMDir /r "$PLUGINSDIR\KudesiSessionManagerAgent"
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  StrCpy $1 ""
  MessageBox MB_ICONEXCLAMATION|MB_YESNO|MB_DEFBUTTON2 "是否同时删除所有店铺 Profile、本机登录态、设备私钥和设备配置？$\r$\n$\r$\n建议选择“否”，以后重新安装可继续使用原数据。" IDYES remove_profiles IDNO preserve_profiles
  remove_profiles:
    StrCpy $1 "-RemoveProfiles -RemoveProfilesConfirmed"
  preserve_profiles:
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\windows\uninstall.ps1" $1' $0
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\KudesiSessionManagerAgent"
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "卸载未完全成功，请联系管理员。店铺 Profile 未被额外删除。"
    SetErrorLevel $0
  ${EndIf}
SectionEnd
