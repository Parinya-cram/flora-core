# Flora — Deployment & Operations

เอกสารอ้างอิงการ deploy Flora บนโครงสร้าง ESM (NAS + Gateway + VM)
อัปเดตล่าสุด: 2026-10-07

---

## 1. เครื่อง / โฮสต์ (hosts)

| เครื่อง | IP | หน้าที่ | SSH |
|---|---|---|---|
| **NAS (UGREEN UGOS)** | `172.22.1.103` | GitLab, Portainer, storage, VM host | `ssh -p 2222 <user>@172.22.1.103` (key-only) |
| **VM (Ubuntu)** | `172.22.1.150` | Flora production (Root/Canopy/Leaf) + reverse proxy | `ssh flora@172.22.1.150` (password) |
| **Gateway** | `172.22.1.233` | Flora Gateway (devices, Kafka, parsers, data-api) | จัดการที่เครื่องเอง |

> VM network = **bridged (vnet-bridge0)** → ได้ IP เองในวง LAN

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

### VM (172.22.1.150) — Flora production
| Port | บริการ | เข้าผ่าน |
|---|---|---|
| **443** | **nginx reverse proxy (TLS)** | `https://<tier>.flora.local` |
| 9443 | Portainer (VM) | `https://172.22.1.150:9443` |
| — | ภายใน (ไม่ publish ออก ใช้ผ่าน nginx) | — |

**เข้าใช้งานจริงผ่าน nginx 443 + hostname:**
| URL | → upstream (tier) |
|---|---|
| `https://leaf.flora.local` | Flora Leaf (workstation) |
| `https://canopy.flora.local` | Flora Canopy (central viewer + Haber) |
| `https://root.flora.local` | Flora Root (cloud control plane) |

> VM เป็นเจ้าของ 443 เอง → ได้ hostname สะอาดไม่ต้องมี :port (ต่างจาก NAS ที่ 443 ถูก UGOS ยึด)

---

## 3. DNS (*.flora.local)

`.flora.local` ไม่ใช่ DNS จริง ต้องให้ resolve → VM:
- **ต่อเครื่อง:** เพิ่มใน `/etc/hosts` (Mac/Linux) หรือ `C:\Windows\System32\drivers\etc\hosts`
  ```
  172.22.1.150  root.flora.local canopy.flora.local leaf.flora.local
  ```
- **ทั้งวง (แนะนำ):** ตั้ง local DNS (Pi-hole / router / dnsmasq) ชี้ `*.flora.local → 172.22.1.150` ทีเดียว

---

## 4. GitLab + Auto-deploy

- **Repo:** `http://172.22.1.103:8080/esm-solution/flora-esm.git` (branch `main`)
- **Remotes (บนเครื่อง dev):** `origin` = GitLab (ESM), `github` = ต้นทาง upstream
- **Flow:** `git push origin main` → Portainer (VM) poll ทุก 1 นาที → redeploy อัตโนมัติ
- **ดึง update จาก GitHub:** `git fetch github && git merge github/floraXesm && git push origin main`

**Portainer (VM) git source:** `flora-gitlab` = repo ข้างบน (user `deploy` + deploy token)

---

## 5. Stacks (VM) — แยก tier คนละ DB

| Stack | compose path | บริการ |
|---|---|---|
| `flora-root` | `flora-root/compose.server.yaml` | root-db, root-api, root-registry |
| `flora-canopy` | `flora-canopy/compose.server.yaml` | canopy-db, canopy-api, canopy-web, sync-api, haber, haber-registry |
| `flora-leaf` | `flora-leaf/compose.server.yaml` | leaf-db, leaf-api, leaf-web, leaf-sync, liveagent |
| `flora-edge` | `flora-edge/compose.server.yaml` | nginx 443 (vhost→upstream) + cloudflared |

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

- cloudflared tunnel บน VM → map public hostname → nginx :443
- ใช้สำหรับ **demo/โชว์** เท่านั้น → ใช้ข้อมูล synthetic, แนะนำเปิด Cloudflare Access กันคนนอก

---

## 8. Operations cheatsheet

```bash
# SSH เข้า VM
ssh flora@172.22.1.150

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
