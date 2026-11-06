!define AFTER_SALES_PROTOCOL_KEY "Software\Classes\kudesi-oa"

!macro customInstall
  WriteRegStr SHCTX "${AFTER_SALES_PROTOCOL_KEY}" "" "URL:Kudesi OA After Sales"
  WriteRegStr SHCTX "${AFTER_SALES_PROTOCOL_KEY}" "URL Protocol" ""
  WriteRegStr SHCTX "${AFTER_SALES_PROTOCOL_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  Push $R0
  ReadRegStr $R0 SHCTX "${AFTER_SALES_PROTOCOL_KEY}\shell\open\command" ""
  StrCmp $R0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
  DeleteRegKey SHCTX "${AFTER_SALES_PROTOCOL_KEY}"
  Pop $R0
!macroend
