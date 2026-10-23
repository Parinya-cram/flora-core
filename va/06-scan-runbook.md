# VA scan runbook — FLORA iCIS

How to re-run the pre-scan ourselves and how to support the hospital's VA vendor on the day.
Run everything from the `flora-core` folder. Save every output under `va/evidence/<yyyy-mm-dd>/`.

## 1. Before the vendor scans

- [ ] Remediation items marked **Before VA** in [05-remediation-plan.md](05-remediation-plan.md) are closed and released.
- [ ] The release under test is pinned (e.g. `canopy/api:1.2.10`) and written in the scope sheet.
- [ ] Production-like configuration: real TLS certificate, no default passwords, `FLORA_ENV=production`
      settings, no dev server (Vite on 7200) reachable.
- [ ] A **test account** (hospital code `vatest`, no real patients) exists for authenticated scanning:
      ```
      docker exec -it flora-canopy-canopy-api-1 python -m app.cli_accounts create vatest "VA Test" --admin vatester
      ```
      Give the vendor the user name and a one-time password over a separate channel. Suspend it after the scan:
      `python -m app.cli_accounts suspend vatest`.
- [ ] Database backup taken (`pg_dump -Fc`) and restore tested.
- [ ] Monitoring on: canopy-api / edge logs kept for the scan window (needed to match vendor findings to requests).
- [ ] Hospital IT has the source IPs of the vendor and the time window (see 01-scope-and-rules-of-engagement.md).

## 2. Our own pre-scan (repeat before every release)

### 2.1 Dependency vulnerabilities

Frontend and desktop (npm):
```
(cd frontend && npm audit --omit=dev --json) > va/evidence/$(date +%F)/npm-audit-frontend.json
npm audit --omit=dev --json > va/evidence/$(date +%F)/npm-audit-desktop.json
```

Python packages actually inside the release images (what runs, not what requirements say):
```
docker run --rm --entrypoint python localhost:7105/flora/canopy/api:<ver> -m pip freeze --all > va/evidence/$(date +%F)/pip-freeze-canopy_api.txt
```
Then check them against OSV (no install needed; see `scripts` block in 03-pre-scan-results.md), or with
pip-audit: `pip-audit -r va/evidence/<date>/pip-freeze-canopy_api.txt`.

### 2.2 Container images (OS packages + language packages)

Trivy is not installed yet. Install once (`brew install trivy`), then per image:
```
trivy image --severity HIGH,CRITICAL --format table -o va/evidence/$(date +%F)/trivy-canopy-api.txt localhost:7105/flora/canopy/api:<ver>
trivy image --severity HIGH,CRITICAL localhost:7105/flora/canopy/haber:<ver>
trivy image --severity HIGH,CRITICAL localhost:7105/flora/leaf/api:<ver>
trivy image --severity HIGH,CRITICAL localhost:7105/flora/leaf/sync:<ver>
trivy config flora-canopy/ flora-leaf/ compose/          # compose / Dockerfile misconfiguration
trivy fs --scanners secret .                             # secrets committed to the repo
```

### 2.3 Network / port scan (only our own hosts)

```
nmap -sV -p- --open -oN va/evidence/$(date +%F)/nmap-canopy.txt <canopy-server-ip>
nmap -sV -p- --open -oN va/evidence/$(date +%F)/nmap-leaf.txt   <leaf-ip>
```
Expected open ports are listed in [02-asset-inventory.md](02-asset-inventory.md). Anything else is a finding.

### 2.4 TLS

```
testssl.sh --html --logfile va/evidence/$(date +%F)/testssl-canopy.log https://<canopy-host>/
```
Target: TLS 1.2+ only, no weak ciphers, valid chain, HSTS present.

### 2.5 Web application (DAST)

OWASP ZAP baseline (passive, safe) and then full scan against the **test account only**:
```
docker run --rm -v "$PWD/va/evidence/$(date +%F)":/zap/wrk ghcr.io/zaproxy/zaproxy:stable \
  zap-baseline.py -t https://<canopy-host>/ -r zap-baseline.html
```
Authenticated scan: sign in as the `vatest` user, copy the `X-FLORA-Session` token and add it as a header
replacement rule (`-z "-config replacer.full_list(0).matchstr=X-FLORA-Session ..."`), or use the ZAP desktop app.

### 2.6 Security headers quick check

```
curl -skI https://<canopy-host>/ | grep -iE "strict-transport|content-security|x-frame|x-content-type|referrer-policy|server:"
curl -sk https://<canopy-host>/docs -o /dev/null -w "%{http_code}\n"     # should be 404 in production
curl -sk https://<canopy-host>/openapi.json -o /dev/null -w "%{http_code}\n"
```

## 3. On the scan day

- Keep an engineer on call; watch `docker logs -f flora-canopy-canopy-api-1` and edge logs.
- If a scan degrades the clinical service (slow charts, sync backlog), ask the vendor to pause — patient care first.
- Note the start and end time; collect the vendor's raw report (not only the PDF summary).

## 4. After the scan

1. Put the vendor report in `va/evidence/<date>/vendor/`.
2. For each finding: confirm, map to our finding ID (or add one) in 04, plan the fix in 05.
3. Mark false positives with the reason and evidence (e.g. "port 7200 is dev only, not present in production compose").
4. Fix, release, re-scan, and attach the re-scan result as closure evidence.
