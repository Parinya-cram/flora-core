// A hospital site (Canopy + the appliance) as Windows processes: PostgreSQL, canopy-api, sync-api, Haber and the
// HTTPS entry (edge.cjs). Same ports as the Linux site (Canopy 9443, appliance 7204), so Root, Leafs and gateways
// see no difference. No image registry here: the appliance hands out the Windows installer from Root's registry.
const fs = require("fs");
const path = require("path");
const rt = require("./runtime.cjs");
const edge = require("./edge.cjs");

const PORTS = { canopy: 9443, haber: 7204, db: 7432, api: 7311, sync: 7312 };

function prepareCanopy(site, baseDir, ip) {
  const dir = path.join(baseDir, "site");
  const settingsFile = path.join(dir, "site.json");
  if (fs.existsSync(settingsFile)) {             // re-install: keep secrets, take the new tenant key
    const s = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    Object.assign(s, { tenantKey: site.tenant_key, rootUrl: site.root_url, rootKey: site.signing_key.public_raw, ip });
    fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
    return s;
  }
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const s = { dir, ip, tenantId: site.tenant_id, name: site.name, tenantKey: site.tenant_key, rootUrl: site.root_url,
    rootKey: site.signing_key.public_raw, rootRegistry: site.registry, account: site.tenant_id.toLowerCase().replace(/-/g, "_").replace(/^([^a-z])/, "h_$1"),
    passwords: { FLORA_DB_ADMIN_PASSWORD: rt.secret(), FLORA_DB_APP_PASSWORD: rt.secret(), FLORA_DB_VIEW_PASSWORD: rt.secret(), FLORA_DB_SYNC_PASSWORD: rt.secret() },
    session: rt.secret(), admin: rt.secret(8), haberAdmin: rt.secret(8), sync: rt.secret(), gatewayToken: rt.secret(), nodeToken: rt.secret() };
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  return s;
}

// The HTTPS certificate for this hospital's Canopy, made with the bundled Python (cryptography).
async function certificate(s) {
  const crt = path.join(s.dir, "tls.crt"), key = path.join(s.dir, "tls.key");
  if (!fs.existsSync(crt)) {
    const py = `
import datetime, ipaddress, socket
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ${JSON.stringify(s.tenantId)})])
now = datetime.datetime.now(datetime.timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
  .serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=1825))
  .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(${JSON.stringify(s.ip)})),
     x509.DNSName(socket.gethostname()), x509.DNSName("localhost")]), False)
  .sign(key, hashes.SHA256()))
open(r"${crt}", "wb").write(cert.public_bytes(serialization.Encoding.PEM))
open(r"${key}", "wb").write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))`;
    await rt.runTool(rt.PYTHON(), ["-c", py]);
  }
  return { cert: fs.readFileSync(crt), key: fs.readFileSync(key) };
}

const db = (s, user, password) => `postgresql://${user}:${password}@127.0.0.1:${PORTS.db}/flora`;

function apiEnv(s) {
  return {
    FLORA_DATABASE_URL: db(s, "flora_view", s.passwords.FLORA_DB_VIEW_PASSWORD),
    FLORA_PLATFORM_DATABASE_URL: db(s, "flora_admin", s.passwords.FLORA_DB_ADMIN_PASSWORD),
    FLORA_API_ENV: "production", FLORA_API_MODE: "canopy", FLORA_CANOPY_SESSION_SECRET: s.session,
    FLORA_BOOTSTRAP_ADMIN_ENABLED: "true", FLORA_BOOTSTRAP_ADMIN_USERNAME: "admin", FLORA_BOOTSTRAP_ADMIN_PASSWORD: s.admin,
    FLORA_BOOTSTRAP_ADMIN_MUST_CHANGE_PASSWORD: "true", FLORA_BOOTSTRAP_ADMIN_NAME: "Canopy Administrator",
    FLORA_HABER_URL: `http://127.0.0.1:${PORTS.haber}`, HABER_ADMIN_USERNAME: "admin", HABER_ADMIN_PASSWORD: s.haberAdmin,
    FLORA_SYNC_SHARED_SECRET: s.sync, FLORA_OCR_MODELS: path.join(rt.RUNTIME(), "ocr"), PYTHAINLP_DATA: path.join(s.dir, "pythainlp"),
    VECTOR_READ_URL: "http://127.0.0.1:9", HIS_GATEWAY_BASE_URL: "http://127.0.0.1:9", FLORA_HIS_DEMO_MODE: "false",
    PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
}

function syncEnv(s) {
  return { FLORA_DATABASE_URL: db(s, "flora_sync", s.passwords.FLORA_DB_SYNC_PASSWORD), FLORA_API_ENV: "production",
    FLORA_API_MODE: "sync", FLORA_SYNC_SHARED_SECRET: s.sync, PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

function haberEnv(s) {
  return {
    FLORA_ROOT_URL: s.rootUrl, FLORA_TENANT_ID: s.tenantId, FLORA_ROOT_TENANT_KEY: s.tenantKey, FLORA_ROOT_PUBLIC_KEY: s.rootKey,
    HABER_GATEWAY_TOKEN: s.gatewayToken, HABER_NODE_TOKEN: s.nodeToken, HABER_ADMIN_USERNAME: "admin", HABER_ADMIN_PASSWORD: s.haberAdmin,
    FLORA_CANOPY_SYNC_URL: `http://127.0.0.1:${PORTS.sync}`, FLORA_CANOPY_SYNC_PUBLIC_URL: `https://${s.ip}:${PORTS.canopy}`,
    FLORA_SYNC_SHARED_SECRET: s.sync, FLORA_APPLIANCE_PUBLIC_URL: `http://${s.ip}:${PORTS.haber}`,
    HABER_REGISTRY_URL: "", HABER_REGISTRY_PUBLIC: s.rootRegistry.replace(/^https?:\/\//, ""), FLORA_ROOT_REGISTRY_URL: s.rootRegistry,
    HABER_DB_PATH: path.join(s.dir, "haber", "haber.db"), HABER_ROOT_SYNC_SEC: "15",
    SSL_CERT_FILE: path.join(s.dir, "root-trust.pem"), PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
  };
}

async function canopyCli(s, args) {
  const api = path.join(rt.RUNTIME(), "apps", "flora_api");
  return rt.runTool(rt.PYTHON(), ["-c", `import sys; sys.path.insert(0, r"${api}"); sys.argv = ["cli_accounts", *${JSON.stringify(args)}];
from app.cli_accounts import main; raise SystemExit(main(sys.argv[1:]))`], { env: apiEnv(s), cwd: api });
}

async function startCanopy(s, supervisor, log) {
  const logDir = path.join(s.dir, "logs");
  fs.mkdirSync(logDir, { recursive: true }); fs.mkdirSync(path.join(s.dir, "haber"), { recursive: true });
  await rt.initDatabase(path.join(s.dir, "db"), PORTS.db, s.passwords, log);
  await rt.startPostgres(path.join(s.dir, "db"), PORTS.db);
  const api = path.join(rt.RUNTIME(), "apps", "flora_api"), haber = path.join(rt.RUNTIME(), "apps", "haber");
  if (!s.adopted) {                              // one time: the hospital's data becomes its Canopy account
    log("Hospital account in Canopy");
    const list = await canopyCli(s, ["list"]).catch(() => "");
    if (!list.split("\n").some((l) => l.startsWith(s.account + " "))) await canopyCli(s, ["adopt-public", s.account, s.name]);
    s.adopted = true; fs.writeFileSync(path.join(s.dir, "site.json"), JSON.stringify(s, null, 2));
  }
  supervisor.start("canopy-api", rt.PYTHON(), rt.pythonApp(api, "app.main:app", "127.0.0.1", PORTS.api), { env: apiEnv(s), cwd: api, logDir });
  supervisor.start("sync-api", rt.PYTHON(), rt.pythonApp(api, "app.main:app", "127.0.0.1", PORTS.sync), { env: syncEnv(s), cwd: api, logDir });
  supervisor.start("haber", rt.PYTHON(), rt.pythonApp(haber, "app.main:app", "0.0.0.0", PORTS.haber), { env: haberEnv(s), cwd: haber, logDir });
  await rt.waitFor(() => rt.httpOk(`http://127.0.0.1:${PORTS.api}/health`), 180, "Canopy API");
  await rt.waitFor(() => rt.httpOk(`http://127.0.0.1:${PORTS.haber}/health`), 120, "appliance");
  const pair = await certificate(s);
  s.server = edge.startCanopyEdge({ port: PORTS.canopy, ...pair, webRoot: path.join(rt.RUNTIME(), "web", "canopy"),
    canopyApi: `http://127.0.0.1:${PORTS.api}`, syncApi: `http://127.0.0.1:${PORTS.sync}` });
  return { canopyUrl: `https://${s.ip}:${PORTS.canopy}`, applianceUrl: `http://${s.ip}:${PORTS.haber}` };
}

async function stopCanopy(s) { s.server?.close(); await rt.stopPostgres(path.join(s.dir, "db")); }

module.exports = { PORTS, prepareCanopy, startCanopy, stopCanopy };
