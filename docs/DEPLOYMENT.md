# Flora — Deployment & Operations

เอกสารอ้างอิงการ deploy Flora บนโครงสร้าง ESM (NAS + Gateway + VM)
อัปเดตล่าสุด: 2026-10-07

---

## 1. เครื่อง / โฮสต์ (hosts)

| เครื่อง | IP | หน้าที่ | SSH |
|---|---|---|---|
| **NAS (UGREEN UGOS)** | `172.22.1.103` | GitLab, Portainer, storage, VM host | `ssh -p 2222 <user>@172.22.1.103` (key-only) |
| **VM (Ubuntu)** | `172.22.1.151` | Flora production (Root/Canopy/Leaf) + reverse proxy | `ssh flora@172.22.1.151` (password) |
| **Gateway** | `172.22.1.233` | Flora Gateway (devices, Kafka, parsers, data-api) | จัดการที่เครื่องเอง |

### VM network = **2 การ์ด (dual-NIC)**
| การ์ด | ชนิด | IP | ใช้ทำอะไร |
|---|---|---|---|
| `ens3` | **vnet-bridge0** (LAN1) | `172.22.1.151/24` | ใช้งานจริง: LAN, เน็ต, คุย Gateway(.233), เสิร์ฟ DNS, เปิดพอร์ต 443 |
| `ens7` | **vnet-host** | `192.100.2.x/24` | เส้นลับคุย NAS (GitLab) เท่านั้น |

> **ทำไมต้อง 2 การ์ด:** VM รันอยู่บน NAS → bridge ของ NAS กั้นไม่ให้ VM คุยกับ "ตัว NAS เอง" (.103)
> (host-isolation — คุยเครื่องอื่นในวงได้หมด ยกเว้น NAS). การ์ด vnet-host ให้ VM คุย NAS ได้ที่ **`192.100.2.1`**
> โดยไม่เสีย IP บน LAN. NAS เองอยู่ที่ `192.100.2.1` บนวงนี้
>
> ⚠️ IP LAN ของ VM มาจาก DHCP (ปัจจุบัน `.151`) — ถ้า IP เปลี่ยน บริการภายในไม่พัง (ใช้ `host.docker.internal`)
> แต่ `HABER_REGISTRY_PUBLIC` + dnsmasq ชี้ `.151` ตรงๆ → ถ้า IP เปลี่ยนต้องแก้/จอง DHCP reservation

---

## 2. Port map

### NAS (172.22.1.103) — infra
| Port | บริการ |
|---|---|
| 8080 | **GitLab CE** (source of truth) |
| 9444 | Portainer (NAS) |
| 9443 / 443 / 80 / 9999 | UGREEN NAS OS (ห้ามแตะ) |
| 2222 | SSH |

### Gateway (172.22.1.233)
| Port | บริการ |
|---|---|
| 7410 | **data-api (Kong)** ← Leaf ดึง device observations จากตรงนี้ |
| 7400 | gateway-service admin (ภายในเครื่อง) |

### VM (172.22.1.151) — Flora production
**เข้าใช้งานจริง = IP:port ต่อ tier (TLS ผ่าน nginx)** — ทั้งวงพิมพ์ URL เข้าได้เลย ไม่ต้องตั้ง DNS/hosts:
| URL | tier |
|---|---|
| **`https://172.22.1.151:7443`** | Flora **Leaf** (workstation) |
| **`https://172.22.1.151:8443`** | Flora **Root** (control plane) |
| **`https://172.22.1.151:9443`** | Flora **Canopy** (central viewer + Haber) |

> cert เป็น self-signed → เบราว์เซอร์เตือน "ไม่ปลอดภัย" กด Advanced → Proceed (ปกติสำหรับ internal)

| Port | บริการ |
|---|---|
| **7443 / 8443 / 9443** | nginx TLS → leaf / root / canopy |
| **9444** | Portainer (VM) — `https://172.22.1.151:9444` (ย้ายจาก 9443 ให้ canopy) |
| 7100 / 7105 | root-api / root-registry |
| 6893 / 6890 | leaf-api / leaf-web (upstream ของ 7443) |
| 6895 / 6894 / 6896 | canopy-api / canopy-web (upstream ของ 9443) / sync-api |
| 7204 / 7205 | haber / haber-registry |
| 6897 | liveagent |

> ไม่มี DNS/hostname แล้ว — เข้าตรงด้วย IP:port (ใครในวงก็ถึง ไม่ต้อง config เครื่อง)
> dnsmasq ถูกถอดออก (เคยชนพอร์ต 53 กับ systemd-resolved และไม่จำเป็นเมื่อใช้ IP:port)

---

## 4. GitLab + Auto-deploy

- **Repo (push จากเครื่อง dev):** `http://172.22.1.103:8080/esm-solution/flora-esm.git` (branch `main`)
- **Repo (Portainer บน VM ดึง):** `http://192.100.2.1:8080/esm-solution/flora-esm.git`
  → VM ต้องใช้ `192.100.2.1` (เส้น vnet-host) เพราะเข้า `.103` ตรงๆ ไม่ได้ (host-isolation)
- **Remotes (บนเครื่อง dev):** `origin` = GitLab (ESM), `github` = ต้นทาง upstream
- **Flow:** `git push origin main` → Portainer (VM) poll → redeploy อัตโนมัติทุก stack
- **ดึง update จาก GitHub:** `git fetch github && git merge github/floraXesm && git push origin main`

**Portainer (VM) GitOps Source:** ชื่อ `flora-gitlab`
- URL `http://192.100.2.1:8080/esm-solution/flora-esm.git`, user `deploy` + deploy token, polling `5m`
- ทั้ง 4 stack ผูกกับ source นี้ (App Delivery → Sources)

---

## 5. Stacks (VM) — แยก tier คนละ DB

| Stack | compose path | บริการ |
|---|---|---|
| `flora-root` | `flora-root/compose.server.yaml` | root-db, root-api, root-registry |
| `flora-canopy` | `flora-canopy/compose.server.yaml` | canopy-db, canopy-api, canopy-web, sync-api, haber, haber-registry |
| `flora-leaf` | `flora-leaf/compose.server.yaml` | leaf-db, leaf-api, leaf-web, leaf-sync, liveagent |
| `flora-edge` | `flora-edge/compose.server.yaml` | nginx TLS 7443/8443/9443 (→leaf/root/canopy) + cloudflared ×4 (1 tunnel/tier) |

**Data flow (offline-first + sync):**
```
Gateway(233) ─data-api→ Leaf(local DB) ─sync เมื่อมีเน็ต→ Canopy(central DB) ─heartbeat→ Root
```

ทุก stack ตั้ง env `FLORA_BIND_ADDR=0.0.0.0`

---

## 6. Credentials (dev/demo — เปลี่ยนก่อนใช้จริงกับข้อมูลคนไข้)

| ระบบ | user / pass |
|---|---|
| Flora (Leaf/Canopy/Root/Haber) | `admin` / `admin` (เปลี่ยนครั้งแรก) |
| DB passwords (dev) | `admin` ทุกตัว |
| Portainer (VM) | ที่ตั้งไว้ตอน setup |
| Gateway key (Haber check-in) | `haber-gateway-demo-token` |
| Root tenant key | `root-tenant-demo-key` (tenant `hospital-01`) |

> ⚠️ ค่าทั้งหมดเป็น dev default — **ก่อนใช้จริงต้องเปลี่ยนเป็นค่าสุ่ม + รีเซ็ต volume**

---

## 7. Cloudflare (external access — demo)

- **1 quick tunnel ต่อ tier** (cloudflared ×4 ใน flora-edge): leaf / root / canopy / gateway
  → แต่ละตัวได้ `https://<random>.trycloudflare.com` เสิร์ฟ tier นั้นที่ root (ไม่มีปัญหา SPA)
- อ่าน URL ของแต่ละตัวจาก log container (บน VM):
  ```bash
  for c in leaf root canopy gateway; do
    echo "== $c =="; docker logs flora-edge-cloudflared-$c-1 2>&1 \
      | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1
  done
  ```
- URL **เปลี่ยนทุกครั้งที่ container restart** (quick tunnel ฟรี). อยากได้ URL คงที่/สวย → ต้องมี domain + named tunnel
- gateway tunnel ชี้ `172.22.1.233:7400` (แก้ได้ด้วย env `GATEWAY_TUNNEL_TARGET`)
- ใช้สำหรับ **demo/โชว์** เท่านั้น → ใช้ข้อมูล synthetic, แนะนำเปิด Cloudflare Access กันคนนอก

---

## 8. Operations cheatsheet

```bash
# SSH เข้า VM
ssh flora@172.22.1.151

# ดู containers
docker ps

# ดู log บริการ
docker logs <container> --tail 100 -f

# redeploy เอง (ปกติ push แล้ว auto): Portainer → stack → Pull and redeploy

# backup DB (ตัวอย่าง canopy)
docker exec flora-canopy-canopy-db-1 pg_dump -U flora_admin flora | gzip > canopy-$(date +%F).sql.gz
```

### ถ้ามี migration ใหม่ (ไฟล์ infrastructure/postgres/*.sql)
postgres รัน init เฉพาะตอน volume ว่าง → ต้องเปลี่ยนชื่อ volume (เช่น v6→v7) ใน compose แล้ว redeploy (ข้อมูลเดิมหาย — backup ก่อน)
