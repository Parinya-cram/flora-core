# =============================================================================================
# Flora Gateway installer for Windows 10 (2004+) / 11, x64 - Docker Desktop + native serial-controller.
# Start it with Install-FloraGateway.cmd (double-click: asks for administrator rights itself).
#
#   Install-FloraGateway.cmd                          settings window, then installs everything
#   Install-FloraGateway.cmd -Answers site.env        settings from a file (KEY=VALUE, same keys as Ubuntu)
#   Install-FloraGateway.cmd -DryRun                  show what would happen, change nothing
#
# Steps
#   1. checks Windows (build, x64, RAM, disk)
#   2. asks the site settings (window): gateway ID, Canopy/Haber, admin account, real COM ports
#      (detected, virtual ports rejected), LAN inputs, Leaf workstations, retention, extras
#   3. installs what is missing: WSL2 (continues by itself after the restart it may need),
#      Docker Desktop (set to start at sign-in), Rust + Build Tools only when serial-controller.exe
#      must be built and no ready-made one is in windows\bin\
#   4. writes .env, config\gateway.windows.toml, config\instances.site.json, kong\kong.yaml and an
#      HTTPS certificate (existing files are backed up first)
#   5. firewall rules, never-sleep power settings, nightly database backup (optional)
#   6. starts the gateway (compose.windows.yaml), serial-controller with its watchdog, start at
#      sign-in, and checks the admin page
# Docker Desktop runs in a signed-in session: for a start without anyone at the PC, turn on
# Windows automatic sign-in (Sysinternals Autologon) - the summary reminds you.
# =============================================================================================
[CmdletBinding()]
param(
    [string]$Answers = '',
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Resume,
    # Folder of FloraGatewaySetup.exe (passed by the setup): a "Docker Desktop Installer.exe" placed
    # next to it is used instead of downloading Docker Desktop (offline sites).
    [string]$SetupDir = '',
    # Test switches: write the site files into another folder and stop (no install, no start).
    [string]$TestTarget = ''
)
$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$GwDir = if ($TestTarget) { $TestTarget } else { (Resolve-Path (Join-Path $ScriptDir '..\..')).Path }
$Project = 'flora-gateway'
# The setup .exe ships no source code: images come loaded, serial-controller.exe ready-made.
$script:HasSource = Test-Path (Join-Path $GwDir 'rust\Cargo.toml')
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$OnWindows = ($PSVersionTable.PSEdition -eq 'Desktop') -or $IsWindows
$StateDir = if ($OnWindows) { Join-Path $env:ProgramData 'FloraGateway' } else { Join-Path ([IO.Path]::GetTempPath()) 'FloraGateway' }
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
$Log = Join-Path $StateDir "install-$Stamp.log"
$Title = 'Flora Gateway installer'
$Utf8 = New-Object Text.UTF8Encoding $false


function Say([string]$text) { Write-Host $text; Add-Content -Path $Log -Value $text -Encoding UTF8 }
function Step([string]$text) { Say ''; Say "==== $text ====" }
function Fail([string]$text) {
    Say "ERROR: $text"
    if ($OnWindows -and -not $TestTarget) {
        Add-Type -AssemblyName System.Windows.Forms
        [void][Windows.Forms.MessageBox]::Show("Installation stopped:`n`n$text`n`nLog: $Log", $Title, 'OK', 'Error')
    }
    exit 1
}
function Run([string]$what, [scriptblock]$action) {
    if ($DryRun -or $TestTarget) { Say "  [dry-run] $what"; return }
    Say "  $what"
    & $action 2>&1 | ForEach-Object { Add-Content -Path $Log -Value "$_" -Encoding UTF8 }
}
# Config files (.env, toml, yaml, json): LF line endings and no BOM - Docker Compose would keep a CR in values.
function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllText($path, ($text -replace "`r`n", "`n"), $Utf8) }
# Windows scripts: CRLF.
function Write-WinText([string]$path, [string]$text) { [IO.File]::WriteAllText($path, ($text -replace "`r?`n", "`r`n"), $Utf8) }
function New-Secret([int]$length = 20) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
    $bytes = New-Object byte[] $length
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

# ------------------------------------------------------------------ answers
$A = [ordered]@{}
$statePath = Join-Path $StateDir 'install-resume.json'
if ($Resume -and (Test-Path $statePath)) {
    (Get-Content $statePath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $A[$_.Name] = $_.Value }
}
if ($Answers) {
    if (-not (Test-Path $Answers)) { Fail "answers file $Answers not found" }
    Get-Content $Answers | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=(.*)$' } | ForEach-Object {
        $A[$Matches[1]] = $Matches[2].Trim().Trim('"')
    }
}

# ------------------------------------------------------------------ 1. machine check
function Test-Machine {
    Step '1/6 Checking this PC'
    if (-not $OnWindows) {
        if (-not ($DryRun -or $TestTarget)) { Fail 'this installer is for Windows (use install-flora-gateway.sh on Ubuntu)' }
        Say '  (not Windows: test mode, machine checks skipped)'; return
    }
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin -and -not $DryRun) { Fail 'run as administrator (start Install-FloraGateway.cmd)' }
    $os = Get-CimInstance Win32_OperatingSystem
    $build = [int]$os.BuildNumber
    $ramGb = [math]::Round($os.TotalVisibleMemorySize / 1MB)
    $drive = (Get-Item $GwDir).PSDrive.Name
    $freeGb = [math]::Round((Get-PSDrive $drive).Free / 1GB)
    Say "  $($os.Caption) build $build, RAM $ramGb GB, free disk $freeGb GB on ${drive}:, folder $GwDir"
    if ($build -lt 19041) { Fail 'Windows 10 version 2004 (build 19041) or newer is needed for WSL2 / Docker Desktop' }
    if (-not [Environment]::Is64BitOperatingSystem) { Fail '64-bit Windows is needed' }
    if ($ramGb -lt 8) { Say "  WARNING: $ramGb GB RAM - Docker Desktop needs 8 GB for a stable gateway" }
    if ($freeGb -lt 30) { Fail "at least 30 GB free disk is needed on ${drive}: (found $freeGb GB)" }
    if (-not (Test-Path (Join-Path $GwDir 'compose.windows.yaml'))) { Fail "compose.windows.yaml not found in $GwDir" }
}

# ------------------------------------------------------------------ COM port detection (real ports only)
$VirtualIds = '^(ROOT\\|COM0COM\\|CNCPORTS|VSBC|VSPD|ELTIMA|VSPE|FABULATECH|HHD)'
function Get-RealComPorts {
    if (-not $OnWindows) { return @() }
    Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%(COM%)'" | ForEach-Object {
        if ($_.Name -match '\((COM\d+)\)') {
            $virtual = ($_.PNPDeviceID -match $VirtualIds) -or ($_.Service -match 'com0com|vsp|vspe|eltima')
            [pscustomobject]@{ Port = $Matches[1]; Name = $_.Name; Ok = ($_.Status -eq 'OK'); Virtual = $virtual
                               Source = ($_.PNPDeviceID -split '\\')[0] }
        }
    } | Sort-Object { [int]($_.Port -replace 'COM', '') }
}

function Get-PrimaryIp {
    if (-not $OnWindows) { return '127.0.0.1' }
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1
    if ($route) { (Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 | Select-Object -First 1).IPAddress } else { '127.0.0.1' }
}

# ------------------------------------------------------------------ 2. settings window
function Show-SettingsWindow {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $form = New-Object Windows.Forms.Form -Property @{ Text = $Title; Width = 720; Height = 760; StartPosition = 'CenterScreen'
        FormBorderStyle = 'FixedDialog'; MaximizeBox = $false; Font = New-Object Drawing.Font('Segoe UI', 9) }
    $y = 12
    $fields = @{}
    function Add-Row([string]$key, [string]$label, [string]$value, [switch]$Password) {
        $l = New-Object Windows.Forms.Label -Property @{ Text = $label; Left = 12; Top = $script:y + 3; Width = 230 }
        $t = New-Object Windows.Forms.TextBox -Property @{ Text = $value; Left = 250; Top = $script:y; Width = 440 }
        if ($Password) { $t.UseSystemPasswordChar = $true }
        $form.Controls.AddRange(@($l, $t)); $fields[$key] = $t; $script:y += 30
    }
    $script:y = $y
    Add-Row GATEWAY_ID 'Gateway ID' $A.GATEWAY_ID
    Add-Row HOST_IP 'IP of this PC on the LAN' $A.HOST_IP
    Add-Row HABER_URL 'Canopy / Haber URL (empty = later)' $A.HABER_URL
    Add-Row HABER_GATEWAY_TOKEN 'Haber gateway token' $A.HABER_GATEWAY_TOKEN
    Add-Row HABER_NODE_TOKEN 'Haber node token (auto-update)' $A.HABER_NODE_TOKEN
    Add-Row ADMIN_USER 'Admin username' $A.ADMIN_USER
    Add-Row ADMIN_PASSWORD 'Admin password (empty = random)' '' -Password
    Add-Row HTTPS_PORT 'HTTPS port' $A.HTTPS_PORT
    Add-Row LEAF_IDS 'Leaf workstations (space separated)' $A.LEAF_IDS
    Add-Row RETENTION_DAYS 'Keep device values (days, 0 = forever)' $A.RETENTION_DAYS

    $lan = New-Object Windows.Forms.CheckBox -Property @{ Text = 'Open the admin page (7400) to the LAN'; Left = 250; Top = $script:y; Width = 440; Checked = ($A.ADMIN_ON_LAN -ne 'no') }
    $form.Controls.Add($lan); $script:y += 32

    $comLabel = New-Object Windows.Forms.Label -Property @{ Text = 'Real COM ports for medical devices (virtual ports are not listed):'; Left = 12; Top = $script:y; Width = 680 }
    $form.Controls.Add($comLabel); $script:y += 22
    $coms = New-Object Windows.Forms.CheckedListBox -Property @{ Left = 12; Top = $script:y; Width = 678; Height = 110; CheckOnClick = $true }
    $ports = @(Get-RealComPorts | Where-Object { -not $_.Virtual -and $_.Ok })
    foreach ($p in $ports) { [void]$coms.Items.Add("$($p.Port)  -  $($p.Name)  [$($p.Source)]", $true) }
    if ($ports.Count -eq 0) { [void]$coms.Items.Add('(no real COM port found - network devices only)'); $coms.Enabled = $false }
    $form.Controls.Add($coms); $script:y += 118

    $netLabel = New-Object Windows.Forms.Label -Property @{ Text = 'Network inputs:'; Left = 12; Top = $script:y; Width = 680 }
    $form.Controls.Add($netLabel); $script:y += 22
    $net = New-Object Windows.Forms.CheckedListBox -Property @{ Left = 12; Top = $script:y; Width = 678; Height = 60; CheckOnClick = $true }
    $current = " $($A.LAN_INPUTS) "
    [void]$net.Items.Add('hl7    HL7 v2 monitors, TCP/MLLP port 7421', ($current -match ' hl7 '))
    [void]$net.Items.Add('vista  Draeger Vista 120 S, TCP port 7422', ($current -match ' vista '))
    [void]$net.Items.Add('m540   Draeger M540 via the IACS relay, TCP port 2051', ($current -match ' m540 '))
    $form.Controls.Add($net); $script:y += 68

    $backup = New-Object Windows.Forms.CheckBox -Property @{ Text = 'Back up the gateway database every night at 02:30 (keeps 7 days)'; Left = 12; Top = $script:y; Width = 680; Checked = ($A.BACKUP -ne 'no') }
    $form.Controls.Add($backup); $script:y += 26
    $power = New-Object Windows.Forms.CheckBox -Property @{ Text = 'Never sleep / hibernate, keep USB serial adapters powered (recommended)'; Left = 12; Top = $script:y; Width = 680; Checked = ($A.POWER -ne 'no') }
    $form.Controls.Add($power); $script:y += 36

    $ok = New-Object Windows.Forms.Button -Property @{ Text = 'Install'; Left = 500; Top = $script:y; Width = 90; DialogResult = 'OK' }
    $cancel = New-Object Windows.Forms.Button -Property @{ Text = 'Cancel'; Left = 600; Top = $script:y; Width = 90; DialogResult = 'Cancel' }
    $form.Controls.AddRange(@($ok, $cancel)); $form.AcceptButton = $ok; $form.CancelButton = $cancel
    $form.Height = $script:y + 80
    if ($form.ShowDialog() -ne 'OK') { Fail 'cancelled' }

    foreach ($k in $fields.Keys) { $A[$k] = $fields[$k].Text.Trim() }
    $A.ADMIN_ON_LAN = if ($lan.Checked) { 'yes' } else { 'no' }
    $A.SERIAL_PORTS = (@($coms.CheckedItems | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ -match '^COM\d+$' }) -join ' ')
    $A.LAN_INPUTS = (@($net.CheckedItems | ForEach-Object { ($_ -split '\s+')[0] }) -join ' ')
    $A.BACKUP = if ($backup.Checked) { 'yes' } else { 'no' }
    $A.POWER = if ($power.Checked) { 'yes' } else { 'no' }
}

function Get-Settings {
    Step '2/6 Site settings'
    $currentId = ''
    $envPath = Join-Path $GwDir '.env'
    if (Test-Path $envPath) { $currentId = ((Get-Content $envPath | Where-Object { $_ -match '^FLORA_GATEWAY_ID=' }) -replace '^FLORA_GATEWAY_ID=', '') | Select-Object -First 1 }
    $hostname = if ($OnWindows) { $env:COMPUTERNAME.ToLower() } else { 'test' }
    $defaults = [ordered]@{ GATEWAY_ID = $(if ($currentId) { $currentId } else { "gateway-$hostname" }); HOST_IP = (Get-PrimaryIp)
        HABER_URL = ''; HABER_GATEWAY_TOKEN = ''; HABER_NODE_TOKEN = ''; ROOT_PUBLIC_KEY = ''; ADMIN_USER = 'admin'; ADMIN_ON_LAN = 'yes'
        HTTPS_PORT = '443'; SERIAL_PORTS = ''; LAN_INPUTS = 'hl7 vista'; LEAF_IDS = ''; RETENTION_DAYS = '30'; BACKUP = 'yes'; POWER = 'yes' }
    $fromFile = $A.Contains('GATEWAY_ID')
    # Running the setup again: start from the previous answers (passwords and tokens are not stored).
    $previous = Join-Path $GwDir 'install\last-answers.env'
    if (-not $fromFile -and (Test-Path $previous)) {
        Get-Content $previous | Where-Object { $_ -match '^\s*([A-Z_]+)\s*=(.*)$' } | ForEach-Object {
            if (-not $A.Contains($Matches[1])) { $A[$Matches[1]] = $Matches[2].Trim().Trim('"') }
        }
    }
    foreach ($k in $defaults.Keys) { if (-not $A.Contains($k)) { $A[$k] = $defaults[$k] } }
    if (-not $fromFile -and $OnWindows -and -not $Resume) { Show-SettingsWindow }
    if (-not $A.Contains('ADMIN_PASSWORD') -or -not $A.ADMIN_PASSWORD) { $A.ADMIN_PASSWORD = New-Secret; $A.ADMIN_PASSWORD_GENERATED = 'yes' }

    if ($A.GATEWAY_ID -notmatch '^[A-Za-z0-9._-]{1,64}$') { Fail "invalid gateway ID '$($A.GATEWAY_ID)'" }
    if ($A.ADMIN_PASSWORD.Length -lt 8) { Fail 'the admin password needs at least 8 characters' }
    if ($A.RETENTION_DAYS -notmatch '^\d+$') { Fail 'retention must be a number of days' }
    foreach ($leaf in ($A.LEAF_IDS -split '\s+' | Where-Object { $_ })) { if ($leaf -notmatch '^[A-Za-z0-9._-]+$') { Fail "invalid Leaf ID '$leaf'" } }
    foreach ($p in ($A.SERIAL_PORTS -split '\s+' | Where-Object { $_ })) {
        if ($p -notmatch '^COM\d+$') { Fail "$p is not a Windows COM port name" }
        if ($OnWindows -and -not $TestTarget) {
            $real = Get-RealComPorts | Where-Object { $_.Port -eq $p }
            if (-not $real) { Fail "$p does not exist on this PC" }
            if ($real.Virtual) { Fail "$p is a virtual port ($($real.Source)) - real ports only" }
        }
    }
}

function Get-Summary {
    $pw = if ($A.ADMIN_PASSWORD_GENERATED -eq 'yes') { '(random, shown at the end)' } else { '(you entered one)' }
    $lanText = if ($A.ADMIN_ON_LAN -eq 'yes') { '(LAN)' } else { '(this PC only)' }
    $keep = if ($A.RETENTION_DAYS -eq '0') { 'forever' } else { "$($A.RETENTION_DAYS) days" }
    $canopy = if ($A.HABER_URL) { $A.HABER_URL } else { 'not connected yet' }
    @"
Gateway ID       $($A.GATEWAY_ID)
This PC          $($A.HOST_IP)
Canopy / Haber   $canopy
Admin account    $($A.ADMIN_USER) / password $pw
Admin page       http://$($A.HOST_IP):7400 $lanText ; https://$($A.HOST_IP):$($A.HTTPS_PORT)
COM ports        $(if ($A.SERIAL_PORTS) { $A.SERIAL_PORTS } else { 'none' })
Network inputs   $(if ($A.LAN_INPUTS) { $A.LAN_INPUTS } else { 'none' })
Leaf routes      $(if ($A.LEAF_IDS) { $A.LEAF_IDS } else { 'none yet' })
Keep values      $keep
Nightly backup   $($A.BACKUP)
Never sleep      $($A.POWER)
"@
}

# ------------------------------------------------------------------ 3. software
function Wait-Docker([int]$seconds = 300) {
    for ($i = 0; $i -lt $seconds / 5; $i++) {
        docker info *> $null
        if ($LASTEXITCODE -eq 0) { return $true }
        Start-Sleep 5
    }
    return $false
}

function Install-Software {
    Step '3/6 Installing what is missing'
    if ($TestTarget) { Say '  skipped (test mode)'; return }
    # WSL2 (Docker Desktop's engine) is turned on by the person installing (it needs a restart and
    # sometimes BIOS virtualization): when it is missing, show the steps and stop without changes.
    $wslOk = $false
    try { wsl.exe --status *> $null; $wslOk = ($LASTEXITCODE -eq 0) } catch { $wslOk = $false }
    if (-not $wslOk) {
        $steps = @"
WSL2 is not turned on yet. Please do this first, then run the Flora Gateway setup again:

  1. Start menu > type  PowerShell  > right-click > Run as administrator
  2. Type this and press Enter:
         wsl --install --no-distribution
  3. Restart Windows when it finishes.
  4. Run Start menu > Flora Gateway > Flora Gateway setup again.

If step 2 says virtualization is disabled: turn on Intel VT-x / AMD-V (SVM) in the BIOS/UEFI
settings of this PC, then repeat the steps.

----
WSL2 ยังไม่ได้เปิด ให้ทำตามนี้ก่อน แล้วเปิด Flora Gateway setup อีกครั้ง:
  1. เมนู Start > พิมพ์ PowerShell > คลิกขวา > Run as administrator
  2. พิมพ์  wsl --install --no-distribution  แล้วกด Enter
  3. รีสตาร์ตเครื่องเมื่อเสร็จ
  4. เปิด Start > Flora Gateway > Flora Gateway setup อีกครั้ง
ถ้าขั้นที่ 2 แจ้งว่า virtualization ปิดอยู่: เปิด Intel VT-x / AMD-V (SVM) ใน BIOS ก่อน
"@
        Say $steps
        if (-not $DryRun) {
            Add-Type -AssemblyName System.Windows.Forms
            [void][Windows.Forms.MessageBox]::Show($steps, "$Title - WSL2 needed", 'OK', 'Information')
        }
        Say '  stopped: WSL2 is not turned on (nothing was changed)'
        exit 2
    }
    Say '  WSL2 present'

    $dockerExe = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (-not (Test-Path $dockerExe)) {
        $installer = $null
        foreach ($name in 'Docker Desktop Installer.exe', 'DockerDesktopInstaller.exe') {
            if ($SetupDir -and (Test-Path (Join-Path $SetupDir $name))) { $installer = Join-Path $SetupDir $name }
        }
        if ($installer) { Say "  using $installer" } else {
            $installer = Join-Path $env:TEMP 'DockerDesktopInstaller.exe'
            Run 'downloading Docker Desktop (about 600 MB; no internet: put "Docker Desktop Installer.exe" next to the setup)' {
                Invoke-WebRequest -UseBasicParsing -Uri 'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe' -OutFile $installer }
        }
        Run 'installing Docker Desktop (WSL2 backend, takes a few minutes)' { Start-Process -Wait -FilePath $installer -ArgumentList 'install', '--quiet', '--accept-license', '--backend=wsl-2' }
        if (-not $DryRun -and -not (Test-Path $dockerExe)) { Fail 'Docker Desktop installation failed' }
    } else { Say '  Docker Desktop present' }
    # Start at sign-in, and the user (not only administrators) may use it.
    $user = (Get-CimInstance Win32_ComputerSystem).UserName
    if ($user) { Run "adding $user to the docker-users group" { Add-LocalGroupMember -Group 'docker-users' -Member $user -ErrorAction SilentlyContinue } }
    foreach ($settings in @("$env:APPDATA\Docker\settings-store.json", "$env:APPDATA\Docker\settings.json")) {
        if (Test-Path $settings) {
            Run "Docker Desktop: start at sign-in ($([IO.Path]::GetFileName($settings)))" {
                $json = Get-Content $settings -Raw | ConvertFrom-Json
                $json | Add-Member -NotePropertyName AutoStart -NotePropertyValue $true -Force
                Write-Text $settings ($json | ConvertTo-Json -Depth 20)
            }
        }
    }
    if (-not $DryRun) {
        docker info *> $null
        if ($LASTEXITCODE -ne 0) { Say '  starting Docker Desktop'; Start-Process $dockerExe }
        if (-not (Wait-Docker 420)) { Fail 'Docker Desktop did not start (open it once, accept the terms, then run the installer again)' }
        Say '  Docker is running'
    }

    # Flora images come with the setup (images\flora-gateway-images.tar.gz): nothing is built here.
    $bundle = Join-Path $GwDir 'images\flora-gateway-images.tar.gz'
    if (Test-Path $bundle) {
        Run 'loading the Flora Gateway images (a few minutes)' {
            docker load -i $bundle
            if ($LASTEXITCODE -ne 0) { throw "docker load failed ($LASTEXITCODE)" }
        }
    } elseif (-not $script:HasSource) {
        Fail 'images\flora-gateway-images.tar.gz is missing from the installation folder: run the setup .exe again'
    }

    # serial-controller.exe comes ready-made in windows\bin\; it is only built when the source is here.
    if ($A.SERIAL_PORTS) {
        $prebuilt = Join-Path $GwDir 'windows\bin\serial-controller.exe'
        if (Test-Path $prebuilt) { Say '  serial-controller.exe present (ready-made)' }
        elseif (-not $script:HasSource) { Fail 'windows\bin\serial-controller.exe is missing: run the setup .exe again' }
        elseif (-not (Test-Path (Join-Path $GwDir 'rust\target\release\serial-controller.exe'))) {
            if (-not (Get-Command cargo -ErrorAction SilentlyContinue) -and -not (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe")) {
                Run 'installing Visual Studio Build Tools (C++), needed to build serial-controller (large download)' {
                    winget install -e --id Microsoft.VisualStudio.2022.BuildTools --accept-package-agreements --accept-source-agreements --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended' }
                Run 'installing Rust' { winget install -e --id Rustlang.Rustup --accept-package-agreements --accept-source-agreements }
                $env:Path += ";$env:USERPROFILE\.cargo\bin"
            }
            Run 'building serial-controller.exe (about 10 minutes the first time)' { & (Join-Path $GwDir 'windows\build-serial-controller.ps1') }
        }
    }
}

# ------------------------------------------------------------------ 4. files
function Write-SiteFiles {
    Step '4/6 Writing the site files'
    $backup = Join-Path $GwDir "install\backups\$Stamp"
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    foreach ($f in '.env', 'config\gateway.windows.toml', 'config\instances.site.json', 'kong\kong.yaml', 'certs\server.crt', 'certs\server.key') {
        $src = Join-Path $GwDir $f
        if (Test-Path $src) { Copy-Item $src (Join-Path $backup ($f -replace '\\', '_')) -Force }
    }
    Say "  previous files backed up to $backup"

    $envPath = Join-Path $GwDir '.env'
    $dbPassword = ''
    if (Test-Path $envPath) { $dbPassword = ((Get-Content $envPath | Where-Object { $_ -match '^FLORA_GATEWAY_DB_PASSWORD=' }) -replace '^FLORA_GATEWAY_DB_PASSWORD=', '') | Select-Object -First 1 }
    if (-not $dbPassword -and $OnWindows -and -not $TestTarget) {
        docker volume inspect "${Project}_gateway_db_data" *> $null
        if ($LASTEXITCODE -eq 0) { $dbPassword = 'flora-gateway-local-only' }   # existing database keeps its password
    }
    if (-not $dbPassword) { $dbPassword = New-Secret 32 }
    $canopyIp = '127.0.0.1'
    if ($A.HABER_URL -match '://(\d+\.\d+\.\d+\.\d+)') { $canopyIp = $Matches[1] }
    $adminBind = if ($A.ADMIN_ON_LAN -eq 'yes') { '0.0.0.0' } else { '127.0.0.1' }
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm'

    $envText = @"
# Flora Gateway site settings (Windows) - written by install\windows\Install-FloraGateway.ps1 on $now
# Used by: docker compose -p $Project -f compose.windows.yaml up -d  and windows\start-gateway.ps1
FLORA_GATEWAY_ID=$($A.GATEWAY_ID)
FLORA_GATEWAY_CONFIG_FILE=gateway.windows.toml
FLORA_GATEWAY_SEED_FILE=instances.site.json

# Canopy / Haber
HABER_URL=$($A.HABER_URL)
HABER_GATEWAY_TOKEN=$($A.HABER_GATEWAY_TOKEN)
HABER_NODE_TOKEN=$($A.HABER_NODE_TOKEN)
FLORA_ROOT_PUBLIC_KEY=$($A.ROOT_PUBLIC_KEY)
FLORA_CANOPY_IP=$canopyIp
GATEWAY_LICENSE_REQUIRED=true

# Leaf workstations read devices here
GATEWAY_DATA_API_URL=http://$($A.HOST_IP):7410/data-api
FLORA_GATEWAY_DATA_API_PORT=7410
FLORA_GATEWAY_DATA_API_BIND=0.0.0.0

# Admin page and accounts
GATEWAY_ADMIN_USERNAME=$($A.ADMIN_USER)
GATEWAY_ADMIN_PASSWORD=$($A.ADMIN_PASSWORD)
FLORA_GATEWAY_ADMIN_BIND=$adminBind
GATEWAY_HTTPS_PORT=$($A.HTTPS_PORT)
FLORA_GATEWAY_DB_PASSWORD=$dbPassword

# Stored device values are deleted after this many days (0 = keep everything)
GATEWAY_DATA_RETENTION_DAYS=$($A.RETENTION_DAYS)
"@

    $pods = ''
    foreach ($p in ($A.SERIAL_PORTS -split '\s+' | Where-Object { $_ })) {
        $pods += @"

[[serial.pods]]
id = "$p"
# Real port $p - line settings follow the device type of the device on it (admin page).
path = "$p"
baud = 9600
data_bits = 8
parity = "none"
"@
    }
    $lan = " $($A.LAN_INPUTS) "
    $socket = ''
    if ($lan -match ' hl7 ') { $socket += "`n[[socket.pods]]`nid = `"or-monitor`"`n# HL7 v2 monitors: TCP/MLLP, LAN port 7421`nport = 9001`nframing = `"mllp`"`nauto_ack = true`n" }
    if ($lan -match ' vista ') { $socket += "`n[[socket.pods]]`nid = `"icu-monitor`"`n# Draeger Vista 120 S (CMS link): TCP, LAN port 7422`nport = 9002`nframing = `"raw`"`nauto_ack = false`n" }
    if ($lan -match ' m540 ') { $socket += "`n[[socket.pods]]`nid = `"m540-relay`"`n# Draeger M540 via the IACS relay: TCP, LAN port 2051`nport = 2051`nframing = `"udp_relay`"`nauto_ack = false`nmax_frame_bytes = 6096`n" }
    $toml = @"
# Flora Gateway site configuration (Windows) - written by install\windows\Install-FloraGateway.ps1 on $now
# Real COM ports only. serial-controller runs natively (windows\start-gateway.ps1); the rest in Docker.
gateway_id = "$($A.GATEWAY_ID)"

[kafka]
brokers = "kafka:9092"

[serial]
admin_port = 7501
$pods

[feeder]
admin_port = 5002

[webhook]
admin_port = 5003

[socket]
admin_port = 5004
$socket

[collector]
admin_port = 5005
batch_size = 500
flush_ms = 500

[server]
listen = "0.0.0.0:8080"

[publisher]
admin_port = 5006
targets = []
"@

    $kong = "# Kong (DB-less) - written by the installer. A Leaf reads its devices at`n#   http://<gateway>:7410/data-api/<leaf-id>/...`n_format_version: `"3.0`"`n`nservices:`n  - name: data-api`n    url: http://server:8080`n    routes:`n      - name: data-api-all`n        paths: [`"/data-api`"]`n        strip_path: true`n"
    foreach ($leaf in ($A.LEAF_IDS -split '\s+' | Where-Object { $_ })) {
        $kong += "  - name: data-api-$leaf`n    url: http://server:8080`n    routes:`n      - name: data-api-$leaf`n        paths: [`"/data-api/$leaf`"]`n        strip_path: true`n    plugins:`n      - name: request-transformer`n        config:`n          add:`n            querystring: [`"leaf_id:$leaf`"]`n"
    }

    if ($DryRun) {
        $out = Join-Path ([IO.Path]::GetTempPath()) "flora-gateway-install-dryrun-$Stamp"
        New-Item -ItemType Directory -Force -Path (Join-Path $out 'config'), (Join-Path $out 'kong') | Out-Null
        Write-Text (Join-Path $out '.env') ($envText -replace '(?m)^(GATEWAY_ADMIN_PASSWORD|FLORA_GATEWAY_DB_PASSWORD|HABER_GATEWAY_TOKEN|HABER_NODE_TOKEN)=.+$', '$1=********')
        Write-Text (Join-Path $out 'config\gateway.windows.toml') $toml
        Write-Text (Join-Path $out 'kong\kong.yaml') $kong
        Say "  [dry-run] files that would be written are in $out (secrets masked)"
        return
    }
    Write-Text $envPath $envText
    if ($OnWindows) {   # .env holds passwords: administrators and SYSTEM only
        icacls $envPath /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" "$($env:USERNAME):F" *> $null
    }
    Write-Text (Join-Path $GwDir 'config\gateway.windows.toml') $toml
    $seed = Join-Path $GwDir 'config\instances.site.json'
    if (-not (Test-Path $seed)) { Write-Text $seed '[]' }
    Write-Text (Join-Path $GwDir 'kong\kong.yaml') $kong
    Say '  wrote .env, config\gateway.windows.toml, config\instances.site.json, kong\kong.yaml'

    if (-not $TestTarget) {
        # HTTPS certificate made with openssl in a container (Windows PowerShell cannot export PEM keys).
        $certs = Join-Path $GwDir 'certs'
        New-Item -ItemType Directory -Force -Path $certs | Out-Null
        Run "HTTPS certificate for $($A.HOST_IP) (valid 3 years)" {
            # openssl from the Flora Rust image (loaded with the setup): works without internet.
            docker run --rm --entrypoint openssl -v "${certs}:/c" flora-gateway-rust:dev req -x509 -newkey rsa:2048 -nodes -days 1095 -subj "/CN=$($A.GATEWAY_ID)" -addext "subjectAltName=IP:$($A.HOST_IP),IP:127.0.0.1,DNS:localhost,DNS:$($A.GATEWAY_ID)" -keyout /c/server.key -out /c/server.crt
            if ($LASTEXITCODE -ne 0) { throw "certificate creation failed ($LASTEXITCODE)" }
        }
    }
}

# ------------------------------------------------------------------ 5. Windows settings
function Set-WindowsForGateway {
    Step '5/6 Windows settings'
    if ($TestTarget) { Say '  skipped (test mode)'; return }
    $ports = @(@{ Name = 'Flora Gateway data-api (Leaf)'; Port = 7410 }, @{ Name = 'Flora Gateway HTTPS'; Port = [int]$A.HTTPS_PORT })
    if ($A.ADMIN_ON_LAN -eq 'yes') { $ports += @{ Name = 'Flora Gateway admin'; Port = 7400 } }
    if ($A.LAN_INPUTS -match 'hl7') { $ports += @{ Name = 'Flora Gateway HL7 (MLLP)'; Port = 7421 } }
    if ($A.LAN_INPUTS -match 'vista') { $ports += @{ Name = 'Flora Gateway Vista 120 S'; Port = 7422 } }
    if ($A.LAN_INPUTS -match 'm540') { $ports += @{ Name = 'Flora Gateway M540 relay'; Port = 2051 } }
    foreach ($p in $ports) {
        Run "firewall: allow TCP $($p.Port) ($($p.Name))" {
            Get-NetFirewallRule -DisplayName $p.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            New-NetFirewallRule -DisplayName $p.Name -Direction Inbound -Protocol TCP -LocalPort $p.Port -Action Allow -Profile Any | Out-Null
        }
    }
    if ($A.POWER -eq 'yes') {
        Run 'power: never sleep or hibernate on AC, keep USB serial adapters powered' {
            powercfg /change standby-timeout-ac 0; powercfg /change hibernate-timeout-ac 0; powercfg /hibernate off
            powercfg /setacvalueindex SCHEME_CURRENT 2a737441-1930-4402-8d77-b2bebba308a3 48e6b7a6-50f5-4782-a5d4-53bb8f07e226 0
            powercfg /setactive SCHEME_CURRENT
        }
    }
    if ($A.BACKUP -eq 'yes') {
        $dir = Join-Path $env:ProgramData 'FloraGateway\backups'
        $script = Join-Path $StateDir 'backup.ps1'
        Run "nightly database backup at 02:30 -> $dir (7 days)" {
            New-Item -ItemType Directory -Force -Path $dir | Out-Null
            Write-WinText $script @"
`$dir = '$dir'
`$file = Join-Path `$dir ('flora_gateway-' + (Get-Date -Format 'yyyyMMdd-HHmm') + '.dump')
docker exec ${Project}-gateway-db-1 pg_dump -U flora_gateway -Fc -f /tmp/backup.dump flora_gateway
docker cp ${Project}-gateway-db-1:/tmp/backup.dump `$file
Get-ChildItem `$dir -Filter 'flora_gateway-*.dump' | Where-Object LastWriteTime -lt (Get-Date).AddDays(-7) | Remove-Item
"@
            $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
            $trigger = New-ScheduledTaskTrigger -Daily -At 2:30am
            Register-ScheduledTask -TaskName 'Flora Gateway backup' -Action $action -Trigger $trigger -RunLevel Highest -Force | Out-Null
        }
    }
}

# ------------------------------------------------------------------ 6. start
function Start-Gateway {
    Step '6/6 Starting Flora Gateway'
    if ($TestTarget) { Say '  skipped (test mode)'; return }
    Push-Location $GwDir
    try {
        if ($A.SERIAL_PORTS) { Run 'checking the COM ports (real ports only)' { & (Join-Path $GwDir 'windows\check-com-ports.ps1') -Config (Join-Path $GwDir 'config\gateway.windows.toml') } }
        $buildFlag = if ($script:HasSource) { '--build' } else { '--no-build' }
        Run "docker compose -f compose.windows.yaml up -d $buildFlag" {
            docker compose -p $Project -f compose.windows.yaml up -d $buildFlag --remove-orphans
            if ($LASTEXITCODE -ne 0) { throw "docker compose failed ($LASTEXITCODE)" }
        }
        if ($A.SERIAL_PORTS) {
            Run 'serial-controller: start at sign-in (Task Scheduler) and start now' {
                & (Join-Path $GwDir 'windows\install-autostart.ps1')
                Start-ScheduledTask -TaskName 'Flora Gateway'
            }
        }
        if (-not $DryRun) {
            Say '  waiting for the admin page'
            $up = $false
            for ($i = 0; $i -lt 60; $i++) {
                try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:7400/login' -TimeoutSec 5; if ($r.StatusCode -eq 200) { $up = $true; break } } catch { }
                Start-Sleep 5
            }
            if (-not $up) { Fail 'the admin page did not come up (docker compose -p flora-gateway -f compose.windows.yaml logs gateway-service)' }
            Say '  admin page is up'
        }
    } finally { Pop-Location }
}

function Save-Answers {
    $file = if ($DryRun) { Join-Path ([IO.Path]::GetTempPath()) "flora-gateway-last-answers-$Stamp.env" } else { Join-Path $GwDir 'install\last-answers.env' }
    $lines = @("# Flora Gateway installer answers ($(Get-Date -Format 'yyyy-MM-dd HH:mm')); secrets are not stored")
    foreach ($k in 'GATEWAY_ID', 'HOST_IP', 'HABER_URL', 'ADMIN_USER', 'ADMIN_ON_LAN', 'HTTPS_PORT', 'SERIAL_PORTS', 'LAN_INPUTS', 'LEAF_IDS', 'RETENTION_DAYS', 'BACKUP', 'POWER') {
        if ($A.Contains($k)) { $lines += "$k=`"$($A[$k])`"" }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $file) | Out-Null
    Write-Text $file ($lines -join "`n")
}

# ------------------------------------------------------------------ main
Say "$Title - $(Get-Date -Format 'yyyy-MM-dd HH:mm')$(if ($DryRun) { '  (DRY RUN: nothing will be changed)' })"
Test-Machine
Get-Settings
Step 'Summary'
$summary = Get-Summary
Say $summary
if (-not $Yes -and -not $Resume) {
    if ($OnWindows) {
        Add-Type -AssemblyName System.Windows.Forms
        if ([Windows.Forms.MessageBox]::Show("Install with these settings?`n`n$summary", $Title, 'YesNo', 'Question') -ne 'Yes') { Fail 'cancelled before any change' }
    } else {
        if ((Read-Host 'Install with these settings? [y/N]') -notmatch '^[yY]') { Fail 'cancelled before any change' }
    }
}
Save-Answers
Install-Software
Write-SiteFiles
if ($TestTarget) { Say ''; Say "Stopped after writing the files into $TestTarget (test mode)."; exit 0 }
Set-WindowsForGateway
Start-Gateway
Remove-Item $statePath -ErrorAction SilentlyContinue

$report = @"
Flora Gateway is installed.

$summary

Admin page   http://$($A.HOST_IP):7400   (or https://$($A.HOST_IP):$($A.HTTPS_PORT))
Username     $($A.ADMIN_USER)
Password     $($A.ADMIN_PASSWORD)
Leaf reads   http://$($A.HOST_IP):7410/data-api/<leaf-id>

Next steps
  1. Sign in and change the password if it was generated (an existing gateway database keeps its admin account).
  2. Canopy: register this gateway (ID $($A.GATEWAY_ID)) so its license and device types arrive.
  3. Docker Desktop starts at sign-in: for a start without anyone at the PC, turn on automatic
     sign-in (Sysinternals Autologon) for this Windows account.
"@
if ($DryRun) { Say ''; Say "Dry run finished: nothing was installed or changed. Log: $Log"; exit 0 }
$reportFile = Join-Path $StateDir "install-$Stamp.txt"
Write-Text $reportFile $report
icacls $reportFile /inheritance:r /grant:r "*S-1-5-32-544:F" "*S-1-5-18:F" *> $null
Say ''; Say $report; Say "(saved to $reportFile, administrators only; log $Log)"
Add-Type -AssemblyName System.Windows.Forms
[void][Windows.Forms.MessageBox]::Show($report, $Title, 'OK', 'Information')
