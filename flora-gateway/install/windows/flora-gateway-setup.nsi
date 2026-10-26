; =============================================================================================
; Flora Gateway setup for Windows 10/11 x64 - built with NSIS (makensis), see build-setup.sh.
; The .exe unpacks the gateway files and runs install\windows\Install-FloraGateway.ps1, which shows
; the settings window and installs WSL2, Docker Desktop and the gateway.
; =============================================================================================
Unicode true
!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef STAGE
  !define STAGE "stage"
!endif
!ifndef OUTFILE
  !define OUTFILE "FloraGatewaySetup-${VERSION}.exe"
!endif
!define APPNAME "Flora Gateway"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FloraGateway"

Name "${APPNAME}"
OutFile "${OUTFILE}"
; No spaces in the path: Docker Compose and the build scripts behave best that way.
InstallDir "C:\FloraGateway"
InstallDirRegKey HKLM "${UNINSTKEY}" "InstallLocation"
RequestExecutionLevel admin
SetCompressor lzma            ; not solid: lets the image bundle be stored as is
ShowInstDetails show
ShowUninstDetails show
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "ESM Solution"
VIAddVersionKey "LegalCopyright" "ESM Solution"

!include "MUI2.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "${APPNAME} ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "This sets up a Flora Gateway on this PC.$\r$\n$\r$\nAfter the files are copied, a settings window asks for the site settings (gateway ID, Canopy, admin account, real COM ports, network inputs). The setup then installs Docker Desktop if it is missing, loads the gateway (included in this file) and starts it.$\r$\n$\r$\nBefore you start: WSL2 must be on (the setup shows how if it is not).$\r$\n$\r$\nNeeds: Windows 10 2004+ or 11 (64-bit), 8 GB RAM, 30 GB free disk; internet only to download Docker Desktop (or put $\"Docker Desktop Installer.exe$\" next to this setup)."
!define MUI_FINISHPAGE_TITLE "Files copied"
!define MUI_FINISHPAGE_TEXT "The gateway settings and installation ran in the Flora Gateway installer window.$\r$\n$\r$\nTo run it again later (change settings, repair): Start menu > Flora Gateway > Flora Gateway setup."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Flora Gateway needs 64-bit Windows."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Flora Gateway needs Windows 10 (version 2004 or newer) or Windows 11."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Section "Flora Gateway" SecMain
  SectionIn RO
  SetShellVarContext all          ; Start menu for all users
  SetOutPath "$INSTDIR"
  ; Site files written by an earlier setup (.env, config\gateway.windows.toml, kong\kong.yaml, certs)
  ; are not in the package, so running a newer setup over an installed gateway keeps them.
  File /r /x flora-gateway-images.tar.gz "${STAGE}\*.*"
  ; The image bundle is gzip already: store it as is (recompressing only costs build time).
  SetOutPath "$INSTDIR\images"
  SetCompress off
  File "${STAGE}\images\flora-gateway-images.tar.gz"
  SetCompress auto
  SetOutPath "$INSTDIR"

  WriteUninstaller "$INSTDIR\Uninstall-FloraGateway.exe"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTKEY}" "Publisher" "ESM Solution"
  WriteRegStr HKLM "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTKEY}" "UninstallString" '"$INSTDIR\Uninstall-FloraGateway.exe"'
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTKEY}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\Flora Gateway"
  CreateShortcut "$SMPROGRAMS\Flora Gateway\Flora Gateway setup.lnk" "$INSTDIR\install\windows\Install-FloraGateway.cmd"
  CreateShortcut "$SMPROGRAMS\Flora Gateway\Flora Gateway admin page.lnk" "http://127.0.0.1:7400/"
  CreateShortcut "$SMPROGRAMS\Flora Gateway\Uninstall Flora Gateway.lnk" "$INSTDIR\Uninstall-FloraGateway.exe"

  DetailPrint "Starting the Flora Gateway installer (settings window)..."
  ExecWait 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\install\windows\Install-FloraGateway.ps1" -SetupDir "$EXEDIR"' $0
  ${If} $0 == 2
    MessageBox MB_ICONINFORMATION "WSL2 must be turned on first (the steps were shown).$\r$\nAfter the restart, run Start menu > Flora Gateway > Flora Gateway setup."
  ${ElseIf} $0 != 0
    MessageBox MB_ICONEXCLAMATION "The Flora Gateway installer stopped (code $0).$\r$\nSee the log in C:\ProgramData\FloraGateway, fix the cause and run Start menu > Flora Gateway > Flora Gateway setup again."
  ${EndIf}
SectionEnd

Section "Uninstall"
  SetRegView 64
  SetShellVarContext all          ; $APPDATA = C:\ProgramData, Start menu of all users
  MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the gateway database and stored device values (Docker volumes)?$\r$\n$\r$\nNo = keep them, so a new installation continues with the same data." IDYES drop IDNO keep
  drop:
    StrCpy $1 "-v"
    Goto stop
  keep:
    StrCpy $1 ""
  stop:
  DetailPrint "Stopping the gateway..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Stop-ScheduledTask -TaskName ''Flora Gateway'' -ErrorAction SilentlyContinue; Get-Process serial-controller -ErrorAction SilentlyContinue | Stop-Process -Force; Unregister-ScheduledTask -TaskName ''Flora Gateway'' -Confirm:$$false -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ''Flora Gateway backup'' -Confirm:$$false -ErrorAction SilentlyContinue; Get-NetFirewallRule -DisplayName ''Flora Gateway*'' -ErrorAction SilentlyContinue | Remove-NetFirewallRule"'
  nsExec::ExecToLog 'cmd.exe /c cd /d "$INSTDIR" && docker compose -p flora-gateway -f compose.windows.yaml down $1 --remove-orphans'
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "docker ps -aq --filter label=flora.gateway.role=parser | ForEach-Object { docker rm -f $$_ }"'

  ; Keep a copy of the site settings (.env, config, certs) next to the backups, then remove the files.
  CreateDirectory "$APPDATA\FloraGateway\uninstalled-site"
  CopyFiles /SILENT "$INSTDIR\.env" "$APPDATA\FloraGateway\uninstalled-site"
  CopyFiles /SILENT "$INSTDIR\config\*.*" "$APPDATA\FloraGateway\uninstalled-site"
  CopyFiles /SILENT "$INSTDIR\kong\kong.yaml" "$APPDATA\FloraGateway\uninstalled-site"
  RMDir /r "$SMPROGRAMS\Flora Gateway"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTKEY}"
  MessageBox MB_ICONINFORMATION "Flora Gateway was removed. The site settings were kept in $APPDATA\FloraGateway\uninstalled-site. Docker Desktop stays installed."
SectionEnd
