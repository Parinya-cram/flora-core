# Flora Gateway installers / ตัวติดตั้ง Flora Gateway

Guided installers that install everything the gateway needs (Docker included), ask the site
settings, write the site files and start the gateway. Re-running them is safe: existing files are
backed up to `install/backups/<date>/` first.

ตัวติดตั้งแบบมีหน้าจอให้เลือก ติดตั้งทุกอย่างที่ gateway ต้องใช้ (รวม Docker) ถามค่าของไซต์ เขียนไฟล์ตั้งค่า
และเปิดระบบให้ รันซ้ำได้ ไฟล์เดิมจะถูกสำรองไว้ที่ `install/backups/<วันที่>/` ก่อนเสมอ

| | Ubuntu 22.04 / 24.04 (or an Ubuntu VM on Windows) | Windows 10 (2004+) / 11 |
|---|---|---|
| Start | `sudo ./install/install-flora-gateway.sh` | double-click `install\windows\Install-FloraGateway.cmd` |
| Screens | menus (arrow keys, space, Enter; works over SSH) | one settings window |
| Installs | Docker Engine + Compose (official repo), whiptail, curl, openssl, python3 | WSL2 (continues by itself after the restart), Docker Desktop, Rust + Build Tools only when `serial-controller.exe` has to be built |
| Runs with | `compose.production.yaml` (real serial ports only, port guard) | `compose.windows.yaml` + native `serial-controller.exe` with a watchdog |
| Starts on boot | yes (Docker service, no sign-in needed) | at sign-in (Docker Desktop); use Windows automatic sign-in for unattended PCs |
| Extras | nightly DB backup (systemd timer), Docker log rotation | nightly DB backup (Task Scheduler), firewall rules, never-sleep power plan |

## Windows setup .exe

`install/windows/build-setup.sh [version]` builds `install/windows/dist/FloraGatewaySetup-<version>.exe`
on Linux (NSIS in Docker). The .exe asks for administrator rights, unpacks the gateway to
`C:\FloraGateway` (no site data inside: no .env, certificates or site configs) and runs the installer
above. It adds Start menu entries (setup again, admin page, uninstall) and an entry in Apps & features;
the uninstaller can keep or delete the gateway data and keeps a copy of the site settings in
`C:\ProgramData\FloraGateway\uninstalled-site`. Put a ready-made `windows/bin/serial-controller.exe`
in place before building so sites do not need the Rust toolchain. The .exe is not code-signed:
Windows SmartScreen shows "unknown publisher" until it is signed with the company certificate.

## Settings asked / ค่าที่ถาม

Gateway ID, the LAN IP of this machine, Canopy/Haber URL and tokens (can be left empty and set
later in the admin page), admin account (empty password = random one, shown at the end), admin page
on the LAN or this machine only, HTTPS port, real serial ports (detected; virtual ports are not
offered), network inputs (HL7 7421, Vista 120 S 7422, M540 relay 2051), Leaf workstations (data-api
routes), how many days to keep stored values, image source (build here or a release), extras.

## Unattended / ติดตั้งแบบไม่ต้องตอบ

Put the answers in a file (`KEY=VALUE`, see `--help`) and pass it:

```bash
sudo ./install/install-flora-gateway.sh --answers site.env --yes
```

```bat
install\windows\Install-FloraGateway.cmd -Answers site.env -Yes
```

The last answers (without passwords and tokens) are saved to `install/last-answers.env`, so the
next run can start from them.

## Try first / ลองก่อนติดตั้งจริง

`--dry-run` (Ubuntu) and `-DryRun` (Windows) ask everything and show what would happen, including
the files they would write (secrets masked), without installing or changing anything.

## Files written / ไฟล์ที่เขียน

| File | Contents |
|---|---|
| `.env` | site settings and secrets (owner-only permissions) |
| `config/gateway.site.toml` (Ubuntu) / `config/gateway.windows.toml` (Windows) | serial and network pods |
| `config/instances.site.json` | starting devices (`[]`; devices come from the admin page or Canopy) |
| `kong/kong.yaml` | one data-api route per Leaf |
| `certs/server.crt`, `certs/server.key` | self-signed HTTPS certificate for this machine (3 years) |

On a machine that already has a gateway database, the database password and the existing admin
account are kept.
