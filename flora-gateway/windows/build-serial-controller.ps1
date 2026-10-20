# Flora Gateway (Windows): builds the native serial-controller.exe (opens real COM ports).          # build serial-controller.exe สำหรับ Windows (เปิดพอร์ต COM จริง)
# Needs Rust with the MSVC toolchain: https://rustup.rs + "Desktop development with C++" (VS Build Tools).  # ต้องติดตั้ง Rust (MSVC) และ Visual Studio Build Tools
# Usage: .\windows\build-serial-controller.ps1                                                     # วิธีใช้
$ErrorActionPreference = 'Stop'                                                                    # หยุดเมื่อมีข้อผิดพลาด
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo not found: install Rust from https://rustup.rs' }   # ต้องมี cargo
Push-Location (Join-Path $PSScriptRoot '..\rust')                                                  # เข้าโฟลเดอร์ซอร์ส Rust
try {                                                                                              # เริ่มส่วนที่ต้องกลับโฟลเดอร์เดิมเสมอ
    cargo build --release --locked -p serial-controller                                            # build แบบ release เฉพาะ serial-controller
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed ($LASTEXITCODE)" }                        # build ไม่ผ่าน = หยุด
    $exe = Resolve-Path 'target\release\serial-controller.exe'                                     # ตำแหน่งไฟล์ที่ได้
    Write-Host "built $exe"                                                                        # แจ้งผล
} finally {                                                                                        # ทำเสมอ
    Pop-Location                                                                                   # กลับโฟลเดอร์เดิม
}                                                                                                  # จบ
