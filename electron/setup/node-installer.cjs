// Installs this Windows (or Linux/macOS) machine as a Flora iCIS Leaf — and optionally a gateway — from the
// hospital appliance, the way leaf.sh / gateway.sh do on Linux: trade the Root one-time code for the node's
// settings, run the approved release's images with Docker (Rancher Desktop on Windows), generate every secret
// here, and report back. Settings live in <userData>/flora-node.json; each node has its own folder.
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const tls = require("tls");
const { execFile } = require("child_process");

const STATE_FILE = (dataDir) => path.join(dataDir, "flora-node.json");

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(dataDir), "utf8")); } catch { return null; }
}
function writeState(dataDir, state) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(STATE_FILE(dataDir), JSON.stringify(state, null, 2));
}

function request(url, { method = "GET", body, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const data = body === undefined ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = lib.request(url, { method, timeout, rejectUnauthorized: false,
      headers: { ...(data ? { "content-type": "application/json", "content-length": data.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = JSON.parse(text); } catch {}
        if (res.statusCode >= 400) reject(Object.assign(new Error((json && json.detail) || text || `HTTP ${res.statusCode}`), { status: res.statusCode }));
        else resolve(json !== null ? json : text);
      });
    });
    req.on("timeout", () => req.destroy(new Error(`no answer from ${url}`)));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function run(cmd, args, { cwd, timeout = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")}: ${(stderr || stdout || error.message).toString().trim().slice(-600)}`));
      else resolve(String(stdout));
    });
  });
}

const secret = (n = 24) => crypto.randomBytes(n).toString("hex");
const normaliseAppliance = (value) => {
  let v = String(value || "").trim().replace(/\/+$/, "");
  if (!v) throw new Error("enter the appliance address");
  if (!/^https?:\/\//.test(v)) v = `http://${v}`;
  if (!/:\d+$/.test(v.replace(/^https?:\/\//, ""))) v = `${v}:7204`;
  return v;
};

async function checkDocker() {
  try {
    const server = (await run("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 20000 })).trim();
    await run("docker", ["compose", "version"], { timeout: 20000 });
    return { ok: true, server };
  } catch (error) {
    return { ok: false, error: "Docker is not running. Install Rancher Desktop (container engine: dockerd/moby), start it, then try again." };
  }
}

// Docker must accept the appliance registry over plain HTTP (it is on the hospital LAN, no certificate).
async function trustRegistry(registry, log) {
  const info = await run("docker", ["info", "--format", "{{json .RegistryConfig.IndexConfigs}}"], { timeout: 20000 }).catch(() => "{}");
  if (info.includes(`"${registry}"`) || /^(localhost|127\.)/.test(registry)) return;
  log(`Allowing the appliance registry ${registry} in Rancher Desktop`);
  // Rancher Desktop runs dockerd in its own VM: a provisioning script keeps the setting across restarts.
  if (process.platform === "win32") {
    const dir = path.join(process.env.LOCALAPPDATA || os.homedir(), "rancher-desktop", "provisioning");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "flora-registry.start"),
      `#!/bin/sh\n# Flora iCIS: the hospital appliance registry is plain HTTP on the LAN.\n` +
      `mkdir -p /etc/docker\n` +
      `python3 - <<'PY' 2>/dev/null || echo '{"insecure-registries":["${registry}"]}' > /etc/docker/daemon.json\n` +
      `import json,os\np='/etc/docker/daemon.json'\nc=json.load(open(p)) if os.path.exists(p) and os.path.getsize(p) else {}\n` +
      `c['insecure-registries']=sorted(set(c.get('insecure-registries',[]))|{'${registry}'})\njson.dump(c,open(p,'w'))\nPY\n`);
  }
  try {
    await run("rdctl", ["shell", "sudo", "sh", "-c",
      `mkdir -p /etc/docker; f=/etc/docker/daemon.json; [ -s $f ] || echo '{}' > $f; ` +
      `grep -q '${registry}' $f || sed -i 's#^{#{"insecure-registries":["${registry}"],#; s#,}#}#' $f; ` +
      `(rc-service docker restart || service docker restart || systemctl restart docker) >/dev/null 2>&1`], { timeout: 120000 });
  } catch (error) {
    throw new Error(`Docker does not trust the appliance registry ${registry} yet. In Rancher Desktop add it as an insecure registry, restart, and run setup again. (${error.message})`);
  }
  for (let i = 0; i < 60; i++) {  // dockerd restarts
    if ((await checkDocker()).ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function freePort(start, step = 10) {
  const net = require("net");
  const isFree = (port) => new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
  for (let port = start; port < start + 2000; port += step) if (await isFree(port)) return port;
  throw new Error(`no free port from ${start}`);
}

function peerCertificatePem(urlString) {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: false }, () => {
      const pems = []; let cert = socket.getPeerCertificate(true); const seen = new Set();
      while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        pems.push(`-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END CERTIFICATE-----`);
        cert = cert.issuerCertificate;
      }
      socket.end(); resolve(pems.join("\n") + "\n");
    });
    socket.setTimeout(10000, () => socket.destroy(new Error(`cannot reach ${urlString}`)));
    socket.on("error", reject);
  });
}

async function releaseImages(appliance, nodeId, kind, token, registryOverride) {
  const desired = await request(`${appliance}/api/haber/v1/nodes/${encodeURIComponent(nodeId)}/desired?component=${kind}`,
    { headers: { authorization: `Bearer ${token}` } });
  if (!desired.release_id) throw new Error(`no ${kind} release is approved and mirrored on the appliance yet (approve one in Device Distribution)`);
  const release = desired.envelope.bundle.releases.find((r) => r.release_id === desired.release_id);
  if (!release) throw new Error(`${desired.release_id} is not in the signed release list`);
  const registry = registryOverride || desired.registry;
  const env = { "# release_id": desired.release_id };
  for (const [key, image] of Object.entries(release.services)) env[`FLORA_IMAGE_${key.toUpperCase()}`] = `${registry}/${image.repository}@${image.digest}`;
  return { release: desired.release_id, registry, env };
}

const envText = (entries) => Object.entries(entries).map(([k, v]) => k.startsWith("#") ? `${k}=${v}` : `${k}=${String(v).replace(/[\r\n]/g, " ")}`).join("\n") + "\n";

async function compose(dir, project, args, files) {
  const fileArgs = files.flatMap((f) => ["-f", path.join(dir, f)]);
  return run("docker", ["compose", "-p", project, "--project-directory", dir, ...fileArgs,
    "--env-file", path.join(dir, ".env"), "--env-file", path.join(dir, ".release", `${project}.env`), ...args], { cwd: dir });
}

async function waitHealthy(dir, project, files, service, log, tries = 90) {
  for (let i = 0; i < tries; i++) {
    const id = (await compose(dir, project, ["ps", "-q", service], files).catch(() => "")).trim();
    if (id) {
      const health = (await run("docker", ["inspect", "-f", "{{.State.Health.Status}}", id]).catch(() => "")).trim();
      if (health === "healthy") return;
    }
    if (i % 6 === 0) log(`waiting for ${service}…`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${service} did not become healthy`);
}

async function report(appliance, code, status, error) {
  await request(`${appliance}/api/haber/v1/install/report`, { method: "POST", body: { code, status, error: error || null } }).catch(() => {});
}

// ------------------------------------------------------------------ Leaf
async function installLeaf({ appliance, code, baseDir, registry: registryOverride }, log) {
  log("Claiming this machine with the appliance");
  const node = await request(`${appliance}/api/haber/v1/install/claim`, { method: "POST",
    body: { code, kind: "leaf", hostname: os.hostname() } });
  if (!node.canopy_sync_url) throw new Error("the appliance has no Canopy address for Leafs (set it in Device Distribution settings)");
  const dir = path.join(baseDir, node.node_id), project = `flora-${node.node_id}`, files = ["compose.yaml"];
  fs.mkdirSync(path.join(dir, "certs"), { recursive: true }); fs.mkdirSync(path.join(dir, ".release"), { recursive: true });
  log(`Leaf ${node.node_id} (${node.label || node.node_id}) · ${[node.ward, node.room, node.bed].filter(Boolean).join(" · ")}`);
  try {
    log("Fetching the approved Leaf release");
    const images = await releaseImages(appliance, node.node_id, "leaf", node.node_token, registryOverride);
    fs.writeFileSync(path.join(dir, ".release", `${project}.env`), envText(images.env));
    await trustRegistry(images.registry, log);
    log("Writing settings and secrets (kept on this machine)");
    fs.writeFileSync(path.join(dir, "compose.yaml"), await request(`${appliance}/install/files/leaf/compose.desktop.yaml`));
    const envFile = path.join(dir, ".env");
    let apiPort;
    if (!fs.existsSync(envFile)) {
      apiPort = await freePort(7301);
      fs.writeFileSync(envFile, envText({
        FLORA_LEAF_ID: node.node_id, FLORA_LEAF_NAME: `"${String(node.label || node.node_id).replace(/"/g, "")}"`,
        FLORA_HOSPITAL_ID: node.tenant_id, CANOPY_SYNC_URL: node.canopy_sync_url, HABER_URL: appliance,
        HABER_NODE_TOKEN: node.node_token, FLORA_SYNC_SHARED_SECRET: node.sync_secret, FLORA_LEAF_SERVICE_SECRET: secret(),
        LEAF_DB_ADMIN_PASSWORD: secret(), LEAF_DB_APP_PASSWORD: secret(), LEAF_DB_VIEW_PASSWORD: secret(), LEAF_DB_SYNC_PASSWORD: secret(),
        LEAF_ADMIN_PASSWORD: secret(8), LEAF_API_PORT: apiPort,
      }));
    } else apiPort = Number((fs.readFileSync(envFile, "utf8").match(/^LEAF_API_PORT=(\d+)/m) || [])[1]);
    if (node.canopy_sync_url.startsWith("https:")) {
      log("Trusting the hospital's Canopy certificate");
      const pem = await peerCertificatePem(node.canopy_sync_url);
      fs.writeFileSync(path.join(dir, "certs", "flora-trust.pem"), tls.rootCertificates.join("\n") + "\n" + pem);
      fs.writeFileSync(path.join(dir, "certs", "trust.env"), "SSL_CERT_FILE=/etc/flora/certs/flora-trust.pem\n");
    }
    log("Pulling the Leaf images from the appliance (first time takes a few minutes)");
    await compose(dir, project, ["pull", "-q"], files);
    await compose(dir, project, ["up", "-d", "--scale", "updater=0"], files);
    await waitHealthy(dir, project, files, "leaf-api", log);
    await compose(dir, project, ["up", "-d", "updater"], files);
    await report(appliance, code, "installed");
    const adminPassword = (fs.readFileSync(envFile, "utf8").match(/^LEAF_ADMIN_PASSWORD=(.*)$/m) || [])[1];
    log(`Leaf ${node.node_id} is running`);
    return { nodeId: node.node_id, label: node.label, dir, project, apiPort, adminPassword, release: images.release };
  } catch (error) {
    await report(appliance, code, "failed", error.message);
    throw error;
  }
}

// ------------------------------------------------------------------ gateway (network devices; COM ports need the native controller)
async function installGateway({ appliance, code, baseDir, registry: registryOverride }, log) {
  log("Claiming this machine as a gateway");
  const node = await request(`${appliance}/api/haber/v1/install/claim`, { method: "POST",
    body: { code, kind: "gateway", hostname: os.hostname() } });
  const dir = path.join(baseDir, node.node_id), project = "flora-gateway", files = ["compose.yaml"];
  for (const sub of ["certs", ".release", "config", "kong", "edge", "db"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  try {
    const images = await releaseImages(appliance, node.node_id, "gateway", node.node_token, registryOverride);
    fs.writeFileSync(path.join(dir, ".release", `${project}.env`), envText(images.env));
    await trustRegistry(images.registry, log);
    const fetch = async (name, target) => fs.writeFileSync(path.join(dir, target), await request(`${appliance}/install/files/gateway/${name}`));
    await fetch("compose.desktop.yaml", "compose.yaml"); await fetch("nginx.conf", "edge/nginx.conf");
    await fetch("0001-gateway.sql", "db/0001-gateway.sql"); await fetch("0002-device-measurements.sql", "db/0002-device-measurements.sql");
    if (!fs.existsSync(path.join(dir, "config", "gateway.toml")))
      fs.writeFileSync(path.join(dir, "config", "gateway.toml"), String(await request(`${appliance}/install/files/gateway/gateway.toml`)).replace("__GATEWAY_ID__", node.node_id));
    if (!fs.existsSync(path.join(dir, "config", "instances.json"))) await fetch("instances.json", "config/instances.json");
    if (!fs.existsSync(path.join(dir, "kong", "kong.yaml"))) await fetch("kong.yaml", "kong/kong.yaml");
    const envFile = path.join(dir, ".env");
    if (!fs.existsSync(envFile)) {
      const ip = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address || "127.0.0.1";
      fs.writeFileSync(envFile, envText({
        FLORA_GATEWAY_ID: node.node_id, HABER_URL: appliance, HABER_GATEWAY_TOKEN: node.gateway_token, HABER_NODE_TOKEN: node.node_token,
        GATEWAY_DATA_API_URL: `http://${ip}:7410/data-api`, FLORA_GATEWAY_DB_PASSWORD: secret(), GATEWAY_ADMIN_PASSWORD: secret(8),
      }));
    }
    log("Pulling the gateway images from the appliance");
    await compose(dir, project, ["pull", "-q"], files);
    await compose(dir, project, ["up", "-d", "--scale", "updater=0"], files);
    await waitHealthy(dir, project, files, "kong", log);
    await compose(dir, project, ["up", "-d", "updater"], files);
    await report(appliance, code, "installed");
    const adminPassword = (fs.readFileSync(envFile, "utf8").match(/^GATEWAY_ADMIN_PASSWORD=(.*)$/m) || [])[1];
    log(`Gateway ${node.node_id} is running`);
    return { nodeId: node.node_id, dir, project, adminPassword, adminUrl: "http://127.0.0.1:7400", release: images.release };
  } catch (error) {
    await report(appliance, code, "failed", error.message);
    throw error;
  }
}

// Bring installed nodes up again after a reboot (containers restart with Docker; this covers a stopped engine).
async function startInstalled(state, log) {
  for (const node of [state?.leaf, state?.gateway].filter(Boolean)) {
    const files = ["compose.yaml"];
    await compose(node.dir, node.project, ["up", "-d"], files).catch((e) => log(`could not start ${node.project}: ${e.message}`));
  }
}

module.exports = { readState, writeState, checkDocker, installLeaf, installGateway, startInstalled, normaliseAppliance };
