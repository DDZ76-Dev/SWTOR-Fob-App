; Extra steps for electron-builder's NSIS installer.

!macro customInstall
  ; Start hidden in the tray at Windows sign-in (same entry the app manages; LOGIN_ITEM_NAME in main.js).
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SWTOR Security Key" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --background'
!macroend

!macro customUnInstall
  ; Remove the "start at Windows sign-in" entry.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SWTOR Security Key"
!macroend
