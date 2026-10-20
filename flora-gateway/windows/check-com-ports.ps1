# Flora Gateway (Windows): verifies every serial pod in the config is a PHYSICAL COM port.            # ตรวจว่า serial pod ทุกตัวใน config เป็นพอร์ต COM จริง
# Rejects virtual/emulated ports (com0com, Eltima/VSPD, VSPE, other root-enumerated software ports). # ปฏิเสธพอร์ตเสมือน (com0com, Eltima/VSPD, VSPE และพอร์ตที่ซอฟต์แวร์สร้าง)
# Usage: .\windows\check-com-ports.ps1 [-Config config\gateway.windows.toml]                      # วิธีใช้
param(                                                                                             # รับพารามิเตอร์
    [string]$Config = (Join-Path $PSScriptRoot '..\config\gateway.windows.toml')                   # ไฟล์ config (ค่าเริ่มต้น gateway.windows.toml)
)                                                                                                  # จบพารามิเตอร์
$ErrorActionPreference = 'Stop'                                                                    # หยุดเมื่อมีข้อผิดพลาด

if (-not (Test-Path $Config)) { throw "config not found: $Config" }                                # ต้องมีไฟล์ config
$paths = Select-String -Path $Config -Pattern '^\s*path\s*=\s*"([^"]+)"' |                         # หาบรรทัด path = "..." ของ serial pod
         ForEach-Object { $_.Matches[0].Groups[1].Value }                                          # เอาเฉพาะค่าในเครื่องหมายคำพูด
if (-not $paths) { Write-Host 'check-com-ports: no serial pods in config'; return }                # ไม่มี serial pod ก็จบ

# Bus/driver prefixes of software-created (virtual) serial ports.                                   # รูปแบบ PNPDeviceID ของพอร์ตเสมือน
$virtualIds = '^(ROOT\\|COM0COM\\|CNCPORTS|VSBC|VSPD|ELTIMA|VSPE|FABULATECH|HHD)'                    # root-enumerated และไดรเวอร์พอร์ตเสมือนยอดนิยม
$failed = $false                                                                                   # ตัวบอกว่ามีพอร์ตไม่ผ่านไหม
foreach ($p in $paths) {                                                                           # วนทุกพอร์ตใน config
    if ($p -notmatch '^COM\d+$') { Write-Host "FAIL $p : not a Windows COM port name"; $failed = $true; continue }   # ต้องเป็นชื่อแบบ COMn
    $dev = Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%($p)%'" | Select-Object -First 1    # หาอุปกรณ์ที่ชื่อลงท้าย (COMn) ใน Device Manager
    if (-not $dev) { Write-Host "FAIL $p : no such port in Device Manager"; $failed = $true; continue }   # ไม่มีพอร์ตนี้ในเครื่อง
    if ($dev.Status -ne 'OK') { Write-Host "FAIL $p : device status $($dev.Status)"; $failed = $true; continue }  # อุปกรณ์มีปัญหา
    if ($dev.PNPDeviceID -match $virtualIds -or $dev.Service -match 'com0com|vsp|vspe|eltima') {   # ตรวจว่าเป็นพอร์ตเสมือน
        Write-Host "FAIL $p : virtual port ($($dev.PNPDeviceID)) — real ports only"; $failed = $true; continue   # ปฏิเสธพอร์ตเสมือน
    }                                                                                              # จบการตรวจพอร์ตเสมือน
    Write-Host "ok   $p : $($dev.Name) [$($dev.PNPDeviceID)]"                                      # ผ่าน: แสดงชื่อและที่มา (ACPI=บนเมนบอร์ด, USB=adapter, PCI=การ์ด)
}                                                                                                  # จบการวน
if ($failed) { throw 'check-com-ports: real COM ports only — fix the config or the hardware' }      # มีพอร์ตไม่ผ่าน = หยุด
Write-Host 'check-com-ports: all serial pods use physical COM ports'                               # ผ่านทั้งหมด
