# Flora Gateway (Windows 10/11): starts the gateway automatically when this user signs in.           # ตั้งให้ gateway เริ่มเองเมื่อผู้ใช้นี้ login
# Docker Desktop on Windows runs inside the user session, so the task runs at sign-in.               # Docker Desktop ทำงานใน session ของผู้ใช้ จึงต้องเริ่มตอน login
# Usage: .\windows\install-autostart.ps1        (install)                                            # ติดตั้ง
#        .\windows\install-autostart.ps1 -Remove (uninstall)                                         # ถอนการติดตั้ง
param(                                                                                               # รับพารามิเตอร์
    [switch]$Remove                                                                                  # ใส่เมื่อต้องการลบ task
)                                                                                                    # จบพารามิเตอร์
$ErrorActionPreference = 'Stop'                                                                      # หยุดเมื่อมีข้อผิดพลาด
$task = 'Flora Gateway'                                                                              # ชื่อ task ใน Task Scheduler
if ($Remove) {                                                                                       # โหมดลบ
    Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue          # ลบ task
    Write-Host "removed scheduled task '$task'"; return                                              # แจ้งผลแล้วจบ
}                                                                                                    # จบโหมดลบ
$script = Resolve-Path (Join-Path $PSScriptRoot 'start-gateway.ps1')                                 # สคริปต์ที่จะรัน
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
          -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""        # รัน PowerShell แบบซ่อนหน้าต่าง
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME                                     # เริ่มเมื่อผู้ใช้นี้ login
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)   # ไม่จำกัดเวลา, ล่มแล้วเริ่มใหม่ทุก 1 นาที
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null   # ลงทะเบียน task (ทับของเดิม)
Write-Host "installed scheduled task '$task' (runs at sign-in of $env:USERNAME)"                     # แจ้งผล
Write-Host 'Also enable: Docker Desktop > Settings > General > "Start Docker Desktop when you sign in"'   # ต้องเปิดให้ Docker Desktop เริ่มตอน login ด้วย
Write-Host 'For start without anyone at the PC: enable Windows automatic sign-in (netplwiz / Sysinternals Autologon)'   # ถ้าต้องการให้เริ่มโดยไม่มีคน login ให้เปิด auto sign-in
