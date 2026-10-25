# Flora Gateway (Windows 10/11): checks real COM ports, starts Docker services, then runs the native  # ตรวจพอร์ต COM จริง → start service ใน Docker → รัน serial-controller บน Windows
# serial-controller and restarts it whenever it exits (stop it to apply new pod settings).             # และ restart serial-controller ให้เองทุกครั้งที่หยุด (หยุดเพื่อให้ใช้ค่าพอร์ตใหม่)
# Usage (PowerShell, from anywhere): .\windows\start-gateway.ps1 [-Build]                             # วิธีใช้ (-Build = build image/exe ใหม่ก่อน)
param(                                                                                                 # รับพารามิเตอร์
    [switch]$Build                                                                                     # ใส่เมื่อต้องการ build ใหม่
)                                                                                                      # จบพารามิเตอร์
$ErrorActionPreference = 'Stop'                                                                        # หยุดเมื่อมีข้อผิดพลาด
$root = Resolve-Path (Join-Path $PSScriptRoot '..')                                                    # โฟลเดอร์ flora-gateway
Set-Location $root                                                                                     # ทำงานในโฟลเดอร์นี้
$logDir = Join-Path $root 'logs'                                                                       # โฟลเดอร์ log
New-Item -ItemType Directory -Force -Path $logDir | Out-Null                                           # สร้างโฟลเดอร์ log ถ้ายังไม่มี
function Log($msg) { $line = "$(Get-Date -Format s) $msg"; Write-Host $line; Add-Content (Join-Path $logDir 'start-gateway.log') $line }   # เขียน log ทั้งจอและไฟล์

# --- settings from .env (same file Docker Compose reads) -------------------------------------------   # อ่านค่าจาก .env
$envFile = @{}                                                                                         # ตารางเก็บค่า
if (Test-Path '.env') {                                                                                # ถ้ามีไฟล์ .env
    Get-Content '.env' | Where-Object { $_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$' } |        # เลือกบรรทัด KEY=VALUE
        ForEach-Object { $envFile[$Matches[1]] = $Matches[2].Trim().Trim('"') }                         # เก็บค่า (ตัดช่องว่างและเครื่องหมายคำพูด)
}                                                                                                      # จบการอ่าน .env
function Setting($name, $default) { if ($envFile.ContainsKey($name) -and $envFile[$name]) { $envFile[$name] } else { $default } }   # อ่านค่าพร้อมค่าเริ่มต้น
$configFile = Setting 'FLORA_GATEWAY_CONFIG_FILE' 'gateway.windows.toml'                               # ชื่อไฟล์ config
$configPath = Join-Path $root "config\$configFile"                                                     # ตำแหน่งไฟล์ config
$kafkaPort  = Setting 'FLORA_GATEWAY_KAFKA_PORT' '7414'                                                # พอร์ต Kafka บนเครื่อง
$dbPort     = Setting 'FLORA_GATEWAY_DB_PORT' '7412'                                                   # พอร์ตฐานข้อมูลบนเครื่อง

# --- 1. Docker Desktop must be running --------------------------------------------------------------  # 1. รอ Docker Desktop พร้อม
Log 'waiting for Docker Desktop'                                                                       # แจ้งสถานะ
for ($i = 0; $i -lt 90; $i++) { docker info *> $null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep 2 }   # รอสูงสุด 3 นาที
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not running (enable "Start Docker Desktop when you sign in")' }   # Docker ไม่พร้อม = หยุด

# --- 2. real COM ports only ---------------------------------------------------------------------------  # 2. ตรวจพอร์ต COM จริง
& (Join-Path $PSScriptRoot 'check-com-ports.ps1') -Config $configPath                                  # พอร์ตเสมือนหรือพอร์ตที่ไม่มี = หยุดตรงนี้

# --- 3. everything except serial-controller in Docker -------------------------------------------------  # 3. start service ใน Docker
$compose = @('compose', '-p', 'flora-gateway', '-f', 'compose.windows.yaml', 'up', '-d')               # คำสั่ง compose
$hasSource = Test-Path (Join-Path $root 'rust\Cargo.toml')                                             # มี source code ในโฟลเดอร์ไหม (ชุดติดตั้ง .exe ไม่มี)
if ($Build -and $hasSource) { $compose += '--build' }                                                  # -Build = build image ใหม่ (เฉพาะเมื่อมี source)
if (-not $hasSource) { $compose += '--no-build' }                                                      # ไม่มี source = ใช้ image ที่โหลดไว้แล้วเท่านั้น
Log "docker $($compose -join ' ')"                                                                     # แจ้งคำสั่ง
docker @compose                                                                                        # รัน compose
if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }                             # ไม่ผ่าน = หยุด

# --- 4. native serial-controller --------------------------------------------------------------------  # 4. เตรียม serial-controller.exe
$exe = Join-Path $root 'windows\bin\serial-controller.exe'                                             # exe สำเร็จรูปที่มากับชุดติดตั้ง
if (-not (Test-Path $exe) -or ($Build -and $hasSource)) {                                              # ไม่มี exe สำเร็จรูป หรือสั่ง build เอง
    $exe = Join-Path $root 'rust\target\release\serial-controller.exe'                                # ตำแหน่ง exe ที่ build จาก source
    if ($Build -or -not (Test-Path $exe)) {                                                            # ยังไม่มี หรือสั่ง build
        if (-not $hasSource) { throw 'serial-controller.exe not found (windows\bin\) and no source to build it' }   # ไม่มีทั้ง exe และ source
        & (Join-Path $PSScriptRoot 'build-serial-controller.ps1')                                      # build ใหม่
    }                                                                                                  # จบการ build
}                                                                                                      # จบการเลือก exe
Log "waiting for Kafka on 127.0.0.1:$kafkaPort"                                                        # แจ้งสถานะ
for ($i = 0; $i -lt 90; $i++) { if ((Test-NetConnection 127.0.0.1 -Port $kafkaPort -WarningAction SilentlyContinue).TcpTestSucceeded) { break }; Start-Sleep 2 }   # รอ Kafka สูงสุด 3 นาที

$env:FLORA_GATEWAY_CONFIG = $configPath                                                                # config ที่ serial-controller อ่าน (COM1, COM2 ...)
$env:FLORA_KAFKA_BROKERS = "127.0.0.1:$kafkaPort"                                                      # Kafka ที่เปิดจาก Docker
$env:FLORA_GATEWAY_ID = Setting 'FLORA_GATEWAY_ID' 'gateway-hospital-01-a'                             # รหัส gateway
$env:FLORA_GATEWAY_DATABASE_URL = "postgresql://flora_gateway:$(Setting 'FLORA_GATEWAY_DB_PASSWORD' 'flora-gateway-local-only')@127.0.0.1:$dbPort/flora_gateway"   # ฐานข้อมูลจาก Docker
$env:RUST_LOG = Setting 'RUST_LOG' 'info'                                                              # ระดับ log

# --- 5. watchdog: keep serial-controller running -------------------------------------------------------  # 5. เฝ้า serial-controller ให้ทำงานตลอด
Log 'serial-controller watchdog started (stop the process to restart it with the current config)'      # แจ้งสถานะ
while ($true) {                                                                                        # วนตลอดเวลา
    Log "starting $exe"                                                                                # แจ้งการเริ่ม
    $p = Start-Process -FilePath $exe -NoNewWindow -PassThru `
         -RedirectStandardOutput (Join-Path $logDir 'serial-controller.out.log') `
         -RedirectStandardError (Join-Path $logDir 'serial-controller.err.log')                        # เริ่ม serial-controller (log แยกไฟล์)
    $p.WaitForExit()                                                                                   # รอจนกว่าจะหยุด
    Log "serial-controller exited ($($p.ExitCode)); restarting in 5 s"                                 # แจ้งว่าหยุด
    Start-Sleep 5                                                                                      # รอ 5 วินาทีแล้วเริ่มใหม่
}                                                                                                      # จบการวน
