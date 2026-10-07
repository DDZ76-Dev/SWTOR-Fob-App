; Extra uninstall steps for electron-builder's NSIS installer.
!macro customUnInstall
  ; Remove the "start at Windows sign-in" entry the app creates (LOGIN_ITEM_NAME in main.js).
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "SWTOR Security Key"
!macroend
