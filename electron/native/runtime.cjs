// Flora iCIS native runtime for Windows: the services run as plain processes from the bundled runtime
// (resources/runtime: embeddable Python + Flora bytecode, PostgreSQL, Java + Kafka) — no Docker, no WSL.
// Each installed role keeps its data under <userData>/native/<node>; the app supervises the processes.
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFile } = require("child_process");

const RUNTIME = () => path.join(process.resourcesPath || path.join(__dirname, "..", ".."), "runtime");
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);
const PYTHON = () => path.join(RUNTIME(), "python", exe("python"));
const PG_BIN = (tool) => path.join(RUNTIME(), "pgsql", "bin", exe(tool));
const secret = (n = 24) => crypto.randomBytes(n).toString("hex");

function runTool(file, args, { env, cwd, timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => execFile(file, args, { env: { ...process.env, ...env }, cwd, timeout, windowsHide: true,
    maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => error
      ? reject(new Error(`${path.basename(file)} ${args.slice(0, 2).join(" ")}: ${(stderr || stdout || error.message).toString().trim().slice(-800)}`))
      : resolve(String(stdout))));
}

async function freePort(start, step = 1) {
  const isFree = (port) => new Promise((resolve) => {
    const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
  for (let port = start; port < start + 2000; port += step) if (await isFree(port)) return port;
  throw new Error(`no free port from ${start}`);
}

function httpOk(url, timeout = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => { res.resume(); resolve(res.statusCode < 500); });
    req.on("timeout", () => req.destroy()); req.on("error", () => resolve(false));
  });
}

async function waitFor(check, seconds, what) {
  for (let i = 0; i < seconds; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`${what} did not start`);
}

// ------------------------------------------------------------------ process supervisor
class Supervisor {
  constructor(log) { this.log = log; this.children = new Map(); this.stopping = false; }
  start(name, file, args, { env, cwd, logDir }) {
    const launch = () => {
      if (this.stopping) return;
      fs.mkdirSync(logDir, { recursive: true });
      const out = fs.openSync(path.join(logDir, `${name}.log`), "a");
      const child = spawn(file, args, { cwd, windowsHide: true, stdio: ["ignore", out, out], env: { ...process.env, ...env } });
      this.children.set(name, child);
      child.on("exit", (code) => {
        fs.closeSync(out);
        if (this.children.get(name) === child) this.children.delete(name);
        if (!this.stopping) { this.log(`${name} stopped (${code}); restarting in 5 s`); setTimeout(launch, 5000); }
      });
    };
    launch();
  }
  stop(name) {                                   // stop one process for good (until started again)
    const child = this.children.get(name);
    if (!child) return;
    this.children.delete(name);
    child.removeAllListeners("exit");
    try { child.kill(); } catch {}
  }
  async stopAll() {
    this.stopping = true;
    for (const child of this.children.values()) { try { child.kill(); } catch {} }
    this.children.clear();
  }
}

// ------------------------------------------------------------------ PostgreSQL
// Same database as the Linux image: the Dockerfile.postgres.dev init scripts in order. Their
// `\set x `echo "$ENV"`` lines read passwords from the environment the Unix way; here they come in as -v.
async function initDatabase(dir, port, passwords, log) {
  const data = path.join(dir, "pgdata");
  if (fs.existsSync(path.join(data, "PG_VERSION"))) return false;
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  const pwfile = path.join(dir, ".pw"); fs.writeFileSync(pwfile, passwords.FLORA_DB_ADMIN_PASSWORD);
  log("Creating the database (first start)");
  await runTool(PG_BIN("initdb"), ["-D", data, "-U", "flora_admin", `--pwfile=${pwfile}`, "-E", "UTF8", "--locale=C", "-A", "scram-sha-256"]);
  fs.rmSync(pwfile);
  await startPostgres(dir, port);
  const env = { PGPASSWORD: passwords.FLORA_DB_ADMIN_PASSWORD };
  const conn = ["-h", "127.0.0.1", "-p", String(port), "-U", "flora_admin"];
  await runTool(PG_BIN("createdb"), [...conn, "flora"], { env });
  const init = path.join(RUNTIME(), "db");
  const vars = Object.entries(passwords).flatMap(([k, v]) => ["-v", `${k}=${v}`]);
  for (const file of fs.readFileSync(path.join(init, "order.txt"), "utf8").split(/\r?\n/).filter(Boolean)) {
    let sql = fs.readFileSync(path.join(init, file), "utf8");
    // \set app_password `echo "$FLORA_DB_APP_PASSWORD"`  ->  \set app_password :FLORA_DB_APP_PASSWORD (passed with -v)
    sql = sql.replace(/^\\set\s+(\w+)\s+`echo\s+"\$(\w+)"`\s*$/gm, (_m, name, envName) => `\\set ${name} :${envName}`);
    const tmp = path.join(dir, `init-${file}`); fs.writeFileSync(tmp, sql);
    log(`  ${file}`);
    await runTool(PG_BIN("psql"), [...conn, "-d", "flora", "-v", "ON_ERROR_STOP=1", "-q", ...vars, "-f", tmp], { env });
    fs.rmSync(tmp);
  }
  return true;
}

async function startPostgres(dir, port) {
  const data = path.join(dir, "pgdata");
  const running = await runTool(PG_BIN("pg_ctl"), ["-D", data, "status"]).then(() => true, () => false);
  if (running) return;
  await runTool(PG_BIN("pg_ctl"), ["-D", data, "-l", path.join(dir, "logs", "postgres.log"), "-w", "-t", "120",
    "-o", `-p ${port} -c listen_addresses=127.0.0.1`, "start"]);
}

async function stopPostgres(dir) {
  await runTool(PG_BIN("pg_ctl"), ["-D", path.join(dir, "pgdata"), "-m", "fast", "-w", "stop"]).catch(() => {});
}

// ------------------------------------------------------------------ Python services
function pythonApp(appDir, module, host, port) {
  // The embeddable Python adds neither the cwd nor PYTHONPATH: put the service on sys.path explicitly.
  return ["-c", `import sys; sys.path.insert(0, r"${appDir}"); import uvicorn; uvicorn.run("${module}", host="${host}", port=${port}, log_level="info")`];
}
function pythonScript(appDir, script) {
  return ["-c", `import sys, runpy; sys.path.insert(0, r"${appDir}"); runpy.run_path(r"${path.join(appDir, script)}", run_name="__main__")`];
}

// ------------------------------------------------------------------ Leaf
async function prepareLeaf(node, appliance, baseDir) {
  const dir = path.join(baseDir, node.node_id);
  const settingsFile = path.join(dir, "leaf.json");
  if (fs.existsSync(settingsFile)) return JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  fs.mkdirSync(dir, { recursive: true });
  const settings = {
    nodeId: node.node_id, label: node.label || node.node_id, dir, appliance, tenantId: node.tenant_id,
    canopySyncUrl: node.canopy_sync_url, nodeToken: node.node_token, syncSecret: node.sync_secret,
    dbPort: await freePort(17432), apiPort: await freePort(7301, 10),
    passwords: { FLORA_DB_ADMIN_PASSWORD: secret(), FLORA_DB_APP_PASSWORD: secret(), FLORA_DB_VIEW_PASSWORD: secret(), FLORA_DB_SYNC_PASSWORD: secret() },
    serviceSecret: secret(), adminPassword: secret(8),
  };
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  return settings;
}

function leafEnv(s) {
  return {
    FLORA_DATABASE_URL: `postgresql://flora_app:${s.passwords.FLORA_DB_APP_PASSWORD}@127.0.0.1:${s.dbPort}/flora`,
    FLORA_API_ENV: "production", FLORA_API_MODE: "leaf", FLORA_LEAF_WRITE_API: "true",
    FLORA_BOOTSTRAP_ADMIN_ENABLED: "true", FLORA_BOOTSTRAP_ADMIN_USERNAME: "admin", FLORA_BOOTSTRAP_ADMIN_PASSWORD: s.adminPassword,
    FLORA_BOOTSTRAP_ADMIN_MUST_CHANGE_PASSWORD: "true", FLORA_BOOTSTRAP_ADMIN_NAME: "Administrator",
    FLORA_DEVICE_INGEST_ENABLED: "true", FLORA_LEAF_SERVICE_SECRET: s.serviceSecret,
    FLORA_CANOPY_SYNC_URL: s.canopySyncUrl, FLORA_SYNC_SHARED_SECRET: s.syncSecret,
    FLORA_HABER_URL: s.appliance, HABER_NODE_TOKEN: s.nodeToken,
    FLORA_LEAF_ID: s.nodeId, FLORA_HOSPITAL_ID: s.tenantId, FLORA_LEAF_NAME: s.label,
    VECTOR_READ_URL: "http://127.0.0.1:9", HIS_GATEWAY_BASE_URL: "http://127.0.0.1:9", FLORA_HIS_DEMO_MODE: "false",
    FLORA_OCR_MODELS: path.join(RUNTIME(), "ocr"), PYTHAINLP_DATA: path.join(s.dir, "pythainlp"),
    FLORA_LEAF_API_URL: `http://127.0.0.1:${s.apiPort}`, FLORA_SYNC_INTERVAL_SECONDS: "10",
    PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1",
    ...(s.trustFile ? { SSL_CERT_FILE: s.trustFile } : {}),
  };
}

async function startLeaf(s, supervisor, log) {
  fs.mkdirSync(path.join(s.dir, "logs"), { recursive: true });
  await initDatabase(s.dir, s.dbPort, s.passwords, log);
  await startPostgres(s.dir, s.dbPort);
  const env = leafEnv(s), logDir = path.join(s.dir, "logs");
  const api = path.join(RUNTIME(), "apps", "flora_api"), sync = path.join(RUNTIME(), "apps", "flora_sync_worker");
  supervisor.start("leaf-api", PYTHON(), pythonApp(api, "app.main:app", "127.0.0.1", s.apiPort), { env, cwd: api, logDir });
  await waitFor(() => httpOk(`http://127.0.0.1:${s.apiPort}/health`), 180, "Leaf API");
  supervisor.start("leaf-sync", PYTHON(), pythonScript(sync, "sync_worker.pyc"), { env, cwd: sync, logDir });
  return `http://127.0.0.1:${s.apiPort}`;
}

async function stopLeaf(s) { await stopPostgres(s.dir); }

module.exports = { RUNTIME, PYTHON, Supervisor, freePort, httpOk, waitFor, runTool, initDatabase, startPostgres, stopPostgres,
  pythonApp, pythonScript, prepareLeaf, leafEnv, startLeaf, stopLeaf, secret };
