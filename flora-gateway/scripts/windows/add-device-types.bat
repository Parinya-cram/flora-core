@echo off
rem Flora Gateway: add device types (local templates) for the patient monitors in
rem "CIS-LIFE Patient Monitor Database" (medical_device_support.pdf) whose protocol Flora Gateway
rem reads with a parser that is in the gateway's parser image (flora-gateway-parser:dev):
rem   protocol hl7v2           -> parser hl7v2 (GE models: hidro_hl7, with GE parameter names)
rem   protocol draeger-vista-s -> parser draeger_vista_s (Vista CMS link, TCP)
rem   protocol ge-s5-dri       -> parser ge_dri (GE S/5 DRI over RS-232)
rem Models with no such protocol/parser are not listed.
rem A protocol match is not a model validation: check each HL7 model's OBX codes, units and
rem timestamps against the real device before clinical use.
rem
rem Targets for the picked models:
rem   1 Flora Root    - add their type codes to a tenant's license (root-license-add-types.ps1: reads the
rem                     current license, keeps every other field, asks before issuing)       (default)
rem   2 Flora Gateway - create the device types (POST /api/device-types) with the parser, connection
rem                     defaults and options for their route; missing manufacturers are added first
rem   3 both
rem
rem   add-device-types.bat                 menu
rem   add-device-types.bat 1 39 81         these entries (numbers as in the PDF; 81-82 = direct RS-232 route)
rem   add-device-types.bat ALL             every entry
rem   add-device-types.bat HL7             HL7 v2 built in        (support = hl7)
rem   add-device-types.bat OPT             HL7 v2 vendor option   (support = hl7-option)
rem   add-device-types.bat NATIVE          dedicated Flora parser (support = native)
rem
rem Needs curl.exe and PowerShell (Windows 10/11 have both), a Root admin and/or a gateway admin account.
rem A device of a type can be enabled only when the type exists on the gateway (or comes from Canopy)
rem AND its code is in the license.
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul

set "GW=http://172.22.1.233:7400"
set "GWUSER=admin"
set "ROOT=https://172.22.19.81:8443"
set "ROOT_TENANT=kcmh"
set "ROOTUSER=admin"
set "TMPDIR_=%TEMP%\flora-device-types"
if not exist "%TMPDIR_%" mkdir "%TMPDIR_%"
where curl >nul 2>&1 || (echo curl.exe not found. Install curl or use Windows 10/11. & exit /b 1)

echo ================================================================
echo  Flora - device types from medical_device_support.pdf
echo ================================================================
call :list

set "PICK=%*"
if not "%PICK%"=="" goto picked
echo.
echo Choose entries:
echo   numbers   e.g. 1 2 39  (several separated by spaces)
echo   ALL       every entry above
echo   HL7       HL7 v2 built in                     (support = hl7)
echo   OPT       HL7 v2 with the vendor's HL7 option (support = hl7-option)
echo   NATIVE    dedicated Flora parser              (support = native)
echo   Q         quit
set /p "PICK=Your choice: "
:picked
if /i "%PICK%"=="Q" exit /b 0
if "%PICK%"=="" exit /b 0

rem Picks -> entry numbers (pick order, no duplicates) and their type codes.
set "NUMS=" & set "CODES=" & set /a SKIPPED=0
for %%n in (%PICK%) do (
  set "TOKEN=%%n"
  if /i "!TOKEN!"=="ALL" (call :each "") else if /i "!TOKEN!"=="HL7" (call :each "hl7") else if /i "!TOKEN!"=="OPT" (call :each "hl7-option") else if /i "!TOKEN!"=="NATIVE" (call :each "native") else (call :pick "!TOKEN!")
)
if not defined NUMS (echo Nothing picked. & exit /b 0)
echo.
echo Picked:%CODES%

echo.
echo Send to:
echo   1  Flora Root    - add their type codes to the tenant license
echo   2  Flora Gateway - create the device types (parser, connection settings)
echo   3  both
set "TARGET=1"
set /p "TARGET=Target [1]: "
if not "%TARGET%"=="2" if not "%TARGET%"=="3" set "TARGET=1"

echo.
echo Mode:
echo   1  send (runs curl; the Root license asks for confirmation first)
echo   2  only show the curl commands (dry run; Root is only read)
set "MODE=1"
set /p "MODE=Mode [1]: "
if not "%MODE%"=="2" set "MODE=1"

set "RESULT=0"
if not "%TARGET%"=="2" (
  set /p "ROOT=Flora Root URL [!ROOT!]: "
  set /p "ROOT_TENANT=Tenant (hospital code) [!ROOT_TENANT!]: "
  set /p "ROOTUSER=Root username [!ROOTUSER!]: "
  set "DRY="
  if "%MODE%"=="2" set "DRY=-DryRun"
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0root-license-add-types.ps1" -Root "!ROOT!" -Tenant "!ROOT_TENANT!" -User "!ROOTUSER!" -Codes "!CODES!" !DRY!
  if errorlevel 1 set "RESULT=1"
)

if "%TARGET%"=="1" goto finish
echo.
echo ---------------- Flora Gateway: device types ----------------
set /p "GW=Gateway URL [%GW%]: "
if "%MODE%"=="1" (
  set /p "GWUSER=Gateway admin username [%GWUSER%]: "
  for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "$s=Read-Host 'Gateway password' -AsSecureString; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))"`) do set "GWPASS=%%p"
  call :check_login || exit /b 1
) else (
  set "GWPASS=********"
)
set /a OK=0, EXISTS=0, FAILED=0
for %%n in (%NUMS%) do call :one "%%n"
echo.
if "%MODE%"=="1" (
  echo Gateway: !OK! created, !EXISTS! already on the gateway, !FAILED! failed.
) else (
  echo Dry run only: nothing was sent to the gateway.
)

:finish
if %SKIPPED% gtr 0 echo %SKIPPED% pick(s) not in the list.
endlocal & exit /b %RESULT%

rem ------------------------------------------------------------------ menu
:list
echo.
echo  No.  Support      Parser           Protocol         Code                                   Model
echo  ---  -----------  ---------------  ---------------  -------------------------------------  -----------------------------
for /f "tokens=2-11 delims=|" %%a in ('findstr /b /c:"::DEV|" "%~f0"') do (
  set "C1=  %%a"
  set "C2=%%f            "
  set "C3=%%b                                       "
  set "C4=%%j                "
  set "C5=%%h                "
  echo  !C1:~-3!  !C2:~0,11!  !C4:~0,15!  !C5:~0,15!  !C3:~0,37!  %%e
)
exit /b 0

rem ------------------------------------------------------------------ selection
:each
for /f "tokens=2,7 delims=|" %%a in ('findstr /b /c:"::DEV|" "%~f0"') do (
  if "%~1"=="" (call :pick "%%a") else if /i "%~1"=="%%b" call :pick "%%a"
)
exit /b 0

rem Adds one entry to NUMS / CODES once.
:pick
set "PCODE="
for /f "tokens=2,3 delims=|" %%a in ('findstr /b /c:"::DEV|%~1|" "%~f0"') do set "PCODE=%%b"
if not defined PCODE (
  echo [%~1] not in the list - skipped
  set /a SKIPPED+=1
  exit /b 0
)
echo  %NUMS% | findstr /c:" %~1 " >nul && exit /b 0
set "NUMS=%NUMS% %~1 "
set "CODES=%CODES% %PCODE%"
exit /b 0

:one
set "FOUND="
for /f "tokens=2-13 delims=|" %%a in ('findstr /b /c:"::DEV|%~1|" "%~f0"') do (
  set "FOUND=1"
  set "NUM=%%a" & set "CODE=%%b" & set "MFR=%%c" & set "MODEL=%%d" & set "LABEL=%%e"
  set "SUPPORT=%%f" & set "CATEGORY=%%g" & set "PROTOCOL=%%h" & set "CONTROLLER=%%i"
  set "PARSER=%%j" & set "CONN=%%k" & set "OPTS=%%l"
)
if not defined FOUND (
  echo [%~1] not in the list - skipped
  set /a SKIPPED+=1
  exit /b 0
)
call :create
exit /b 0

rem ------------------------------------------------------------------ create one type
:create
echo.
echo [%NUM%] %LABEL%  -  %CODE%  (%SUPPORT%, parser %PARSER%)
if /i "%SUPPORT%"=="hl7-option" echo      note: needs the vendor's HL7 option / module on the monitor
call :manufacturer %MFR%
set "JSON=%TMPDIR_%\%CODE%.json"
> "%JSON%" echo {"code":"%CODE%","label":"%LABEL%","manufacturer":"%MFR%","model":"%MODEL%","description":"From medical_device_support.pdf #%NUM% (support: %SUPPORT%). Route: %PROTOCOL% via %CONTROLLER% controller.","category":"%CATEGORY%","protocol":"%PROTOCOL%","controller":"%CONTROLLER%","parser":"%PARSER%","connection_defaults":%CONN%,"default_options":%OPTS%}
echo   curl -sS -u "%GWUSER%:********" -H "Content-Type: application/json" --data-binary "@%JSON%" %GW%/api/device-types
if "%MODE%"=="2" (
  type "%JSON%"
  echo.
  exit /b 0
)
set "CODE_HTTP="
for /f %%h in ('curl -sS -o "%TMPDIR_%\last.txt" -w "%%{http_code}" -u "%GWUSER%:%GWPASS%" -H "Content-Type: application/json" --data-binary "@%JSON%" "%GW%/api/device-types"') do set "CODE_HTTP=%%h"
if "%CODE_HTTP%"=="201" (echo   created & set /a OK+=1 & exit /b 0)
if "%CODE_HTTP%"=="409" (echo   already on the gateway & set /a EXISTS+=1 & exit /b 0)
echo   FAILED (HTTP %CODE_HTTP%):
type "%TMPDIR_%\last.txt"
echo.
set /a FAILED+=1
exit /b 0

rem Adds the manufacturer when the gateway does not have it yet (409 = already there).
:manufacturer
set "MCODE=%~1"
for /f "tokens=3,4 delims=|" %%a in ('findstr /b /c:"::MFR|%MCODE%|" "%~f0"') do (set "MNAME=%%a" & set "MCOUNTRY=%%b")
> "%TMPDIR_%\mfr.json" echo {"code":"%MCODE%","name":"%MNAME%","country":"%MCOUNTRY%"}
if "%MODE%"=="2" (
  echo   curl -sS -u "%GWUSER%:********" -H "Content-Type: application/json" -d "{\"code\":\"%MCODE%\",\"name\":\"%MNAME%\",\"country\":\"%MCOUNTRY%\"}" %GW%/api/manufacturers
  exit /b 0
)
curl -sS -o nul -u "%GWUSER%:%GWPASS%" -H "Content-Type: application/json" --data-binary "@%TMPDIR_%\mfr.json" "%GW%/api/manufacturers"
exit /b 0

:check_login
set "CODE_HTTP="
for /f %%h in ('curl -sS -o nul -w "%%{http_code}" -u "%GWUSER%:%GWPASS%" "%GW%/api/device-types"') do set "CODE_HTTP=%%h"
if "%CODE_HTTP%"=="200" exit /b 0
echo Cannot sign in to %GW% (HTTP %CODE_HTTP%). Check the URL, username and password.
exit /b 1

rem ------------------------------------------------------------------ data
rem ::MFR|code|name|country
rem ::DEV|no|code|manufacturer|model|label|support|category|protocol|controller|parser|connection_defaults|default_options
rem support: hl7 = HL7 v2.x built in (PDF "Yes"); hl7-option = PDF "Optional" (vendor HL7 option needed);
rem native = dedicated Flora parser (Vista CMS link, GE S/5 DRI over RS-232).
rem Not listed (no protocol Flora reads: no HL7 and no Flora parser): #50 Biolight A3/A2E,
rem #59 Welch Allyn Connex ProBP 3400, #73 Contec CMS 6000/5100.
::MFR|philips|Philips|Netherlands
::MFR|ge|GE Healthcare|USA
::MFR|mindray|Mindray|China
::MFR|nihon-kohden|Nihon Kohden|Japan
::MFR|draeger|Draegerwerk AG|Germany
::MFR|spacelabs|Spacelabs|USA
::MFR|edan|Edan|China
::MFR|biolight|Biolight|China
::MFR|comen|Comen|China
::MFR|schiller|Schiller|Switzerland
::MFR|welch-allyn|Welch Allyn (Baxter)|USA
::MFR|masimo|Masimo|USA
::MFR|fukuda-denshi|Fukuda Denshi|Japan
::MFR|zoll|Zoll|USA
::MFR|bpl-medical|BPL Medical|India
::MFR|contec|Contec Medical|China
::MFR|hamilton-medical|Hamilton Medical|Switzerland
::MFR|mediana|Mediana|South Korea
::MFR|skanray|Skanray|India
::MFR|infinium-medical|Infinium Medical|USA
::MFR|siemens-healthineers|Siemens Healthineers|Germany
::DEV|1|philips-intellivue-mx800-hl7|philips|IntelliVue MX800|Philips IntelliVue MX800 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|2|philips-intellivue-mx750-hl7|philips|IntelliVue MX750|Philips IntelliVue MX750 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|3|philips-intellivue-mx700-hl7|philips|IntelliVue MX700|Philips IntelliVue MX700 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|4|philips-intellivue-mx600-hl7|philips|IntelliVue MX600|Philips IntelliVue MX600 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|5|philips-intellivue-mx500-hl7|philips|IntelliVue MX500|Philips IntelliVue MX500 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|6|philips-intellivue-mx400-hl7|philips|IntelliVue MX400|Philips IntelliVue MX400 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|7|philips-intellivue-x3-mx100-hl7|philips|IntelliVue X3 / MX100|Philips IntelliVue X3 / MX100 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|8|philips-intellivue-mp70-mp60-hl7|philips|IntelliVue MP70/MP60|Philips IntelliVue MP70/MP60 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|9|philips-intellivue-mp50-mp40-mp30-hl7|philips|IntelliVue MP50/MP40/MP30|Philips IntelliVue MP50/MP40/MP30 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|10|philips-intellivue-mp20-mp5-hl7|philips|IntelliVue MP20/MP5|Philips IntelliVue MP20/MP5 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|11|philips-earlyvue-vs30-hl7|philips|EarlyVue VS30|Philips EarlyVue VS30 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|12|ge-carescape-b850-hl7|ge|CARESCAPE B850|GE CARESCAPE B850 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|13|ge-carescape-b650-hl7|ge|CARESCAPE B650|GE CARESCAPE B650 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|14|ge-carescape-b450-hl7|ge|CARESCAPE B450|GE CARESCAPE B450 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|15|ge-carescape-b125-hl7|ge|CARESCAPE B125|GE CARESCAPE B125 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|16|ge-carescape-one-hl7|ge|CARESCAPE ONE|GE CARESCAPE ONE (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|17|ge-solar-8000mi-hl7|ge|Solar 8000M/i|GE Solar 8000M/i (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|18|ge-dinamap-procare-v100-hl7|ge|DINAMAP ProCare V100|GE DINAMAP ProCare V100 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hidro_hl7|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok","repair_segments":false}
::DEV|19|mindray-benevision-n22-n19-hl7|mindray|BeneVision N22/N19|Mindray BeneVision N22/N19 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|20|mindray-benevision-n17-hl7|mindray|BeneVision N17|Mindray BeneVision N17 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|21|mindray-benevision-n15-hl7|mindray|BeneVision N15|Mindray BeneVision N15 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|22|mindray-benevision-n12-hl7|mindray|BeneVision N12|Mindray BeneVision N12 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|23|mindray-benevision-n1-hl7|mindray|BeneVision N1|Mindray BeneVision N1 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|24|mindray-benevision-v12-v8-v6-hl7|mindray|BeneVision V12/V8/V6|Mindray BeneVision V12/V8/V6 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|25|mindray-epm-15m-12m-10m-hl7|mindray|ePM 15M/12M/10M|Mindray ePM 15M/12M/10M (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|26|mindray-imec-15-12-10-8-hl7|mindray|iMEC 15/12/10/8|Mindray iMEC 15/12/10/8 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|27|mindray-vs-900-800-600-hl7|mindray|VS 900/800/600|Mindray VS 900/800/600 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|28|nihon-kohden-g7-csm-1700-hl7|nihon-kohden|Life Scope G7 (CSM-1700)|Nihon Kohden Life Scope G7 (CSM-1700) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|29|nihon-kohden-g5-csm-1500-hl7|nihon-kohden|Life Scope G5 (CSM-1500)|Nihon Kohden Life Scope G5 (CSM-1500) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|30|nihon-kohden-g5-max-hl7|nihon-kohden|Life Scope G5 Max|Nihon Kohden Life Scope G5 Max (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|31|nihon-kohden-e7-bsm-5700-hl7|nihon-kohden|Life Scope E7 (BSM-5700)|Nihon Kohden Life Scope E7 (BSM-5700) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|32|nihon-kohden-g3-gz-130-140-hl7|nihon-kohden|Life Scope G3 (GZ-130/140)|Nihon Kohden Life Scope G3 (GZ-130/140) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|33|nihon-kohden-svm-7200-hl7|nihon-kohden|Life Scope SVM-7200|Nihon Kohden Life Scope SVM-7200 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|34|nihon-kohden-bsm-2301k-hl7|nihon-kohden|Life Scope BSM-2301K|Nihon Kohden Life Scope BSM-2301K (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|35|draeger-infinity-vista-xl-hl7|draeger|Infinity Vista XL|Draeger Infinity Vista XL (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|36|draeger-infinity-delta-xl-hl7|draeger|Infinity Delta XL|Draeger Infinity Delta XL (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|37|draeger-infinity-delta-hl7|draeger|Infinity Delta|Draeger Infinity Delta (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|38|draeger-infinity-acs-hl7|draeger|Infinity Acute Care System|Draeger Infinity Acute Care System (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|39|draeger-vista-120s|draeger|Vista 120 S|Draeger Vista 120 S patient monitor (CMS link, TCP)|native|patient_monitor|draeger-vista-s|socket|draeger_vista_s|{"transport":"tcp","framing":"raw","auto_ack":false}|{"min_interval_sec":1}
::DEV|40|spacelabs-xprezon-hl7|spacelabs|XPREZZON|Spacelabs XPREZZON (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|41|spacelabs-qube-hl7|spacelabs|qube|Spacelabs qube (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|42|spacelabs-elance-hl7|spacelabs|Elance|Spacelabs Elance (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|43|edan-elite-v8-hl7|edan|Elite V8|Edan Elite V8 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|44|edan-im80-hl7|edan|iM80|Edan iM80 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|45|edan-im70-hl7|edan|iM70|Edan iM70 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|46|edan-im60-hl7|edan|iM60|Edan iM60 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|47|edan-im20-im50-hl7|edan|iM20/iM50|Edan iM20/iM50 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|48|biolight-anyview-a8-hl7|biolight|AnyView A8|Biolight AnyView A8 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|49|biolight-anyview-a6-a5-hl7|biolight|AnyView A6/A5|Biolight AnyView A6/A5 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|51|comen-star-8800-hl7|comen|STAR 8800|Comen STAR 8800 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|52|comen-star-8000-5000-hl7|comen|STAR 8000/STAR 5000|Comen STAR 8000/STAR 5000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|53|comen-c100-c80-c60-hl7|comen|C100/C80/C60|Comen C100/C80/C60 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|54|schiller-argus-pro-lifevue-hl7|schiller|ARGUS PRO LifeVue|Schiller ARGUS PRO LifeVue (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|55|schiller-argus-lcm-plus-hl7|schiller|ARGUS LCM plus|Schiller ARGUS LCM plus (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|56|schiller-ds20-hl7|schiller|DS20|Schiller DS20 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|57|welch-allyn-connex-vsm-6000-hl7|welch-allyn|Connex VSM 6000|Welch Allyn Connex VSM 6000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|58|welch-allyn-connex-spot-monitor-hl7|welch-allyn|Connex Spot Monitor (CSM)|Welch Allyn Connex Spot Monitor (CSM) (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|60|masimo-root-hl7|masimo|Root|Masimo Root (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|61|masimo-radical-7-hl7|masimo|Radical-7|Masimo Radical-7 (HL7 v2 via Root / Patient SafetyNet)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|62|masimo-patient-safetynet-hl7|masimo|Patient SafetyNet|Masimo Patient SafetyNet (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|63|fukuda-denshi-ds-8900-hl7|fukuda-denshi|DS-8900|Fukuda Denshi DS-8900 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|64|fukuda-denshi-ds-8500-hl7|fukuda-denshi|DS-8500|Fukuda Denshi DS-8500 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|65|fukuda-denshi-ds-8007-hl7|fukuda-denshi|DS-8007|Fukuda Denshi DS-8007 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|66|fukuda-denshi-ds-7700-hl7|fukuda-denshi|Dynascope DS-7700|Fukuda Denshi Dynascope DS-7700 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|67|zoll-propaq-m-hl7|zoll|Propaq M|Zoll Propaq M (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|68|zoll-propaq-md-hl7|zoll|Propaq MD|Zoll Propaq MD (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|69|zoll-x-series-hl7|zoll|X Series|Zoll X Series (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|70|bpl-medical-ultima-prime-hl7|bpl-medical|Ultima Prime|BPL Ultima Prime (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|71|bpl-medical-excello-hl7|bpl-medical|Excello|BPL Excello (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|72|contec-cms-9200-8000-hl7|contec|CMS 9200/8000|Contec CMS 9200/8000 (HL7 v2 option)|hl7-option|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|74|hamilton-medical-c6-intellicuff-hl7|hamilton-medical|C6 with IntelliCuff|Hamilton Medical C6 with IntelliCuff (HL7 v2)|hl7|ventilator|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|75|mediana-ym6000-hl7|mediana|YM6000|Mediana YM6000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|76|mediana-ym1000-hl7|mediana|YM1000|Mediana YM1000 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|77|skanray-star-70-60-50-hl7|skanray|Star 70/60/50|Skanray Star 70/60/50 (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|78|infinium-medical-omni-k-hl7|infinium-medical|OMNI K|Infinium OMNI K (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|79|infinium-medical-omni-ii-hl7|infinium-medical|OMNI II|Infinium OMNI II (HL7 v2)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|80|siemens-healthineers-sc-9000-xl-hl7|siemens-healthineers|SC 9000 XL|Siemens SC 9000 XL (HL7 v2 via Infinity Gateway)|hl7|patient_monitor|hl7v2|socket|hl7v2|{"transport":"tcp","framing":"mllp","auto_ack":true}|{"timezone":"Asia/Bangkok"}
::DEV|81|ge-carescape-b650-dri|ge|CARESCAPE B650|GE CARESCAPE B650 (direct RS-232, S/5 DRI)|native|patient_monitor|ge-s5-dri|serial|ge_dri|{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"hardware","dtr":true,"idle_ms":20}|{"checksum_mode":"escaped","dri_levels":[12,11,10,9,8,6]}
::DEV|82|ge-carescape-b850-dri|ge|CARESCAPE B850|GE CARESCAPE B850 (direct RS-232, S/5 DRI)|native|patient_monitor|ge-s5-dri|serial|ge_dri|{"baud":19200,"data_bits":8,"parity":"even","stop_bits":1,"flow_control":"hardware","dtr":true,"idle_ms":20}|{"checksum_mode":"escaped","dri_levels":[12,11,10,9,8,6]}
