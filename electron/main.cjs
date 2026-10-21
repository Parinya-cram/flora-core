const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell } = require("electron");
const installer = require("./setup/node-installer.cjs");
const { buildReportPdfBuffer } = require("./reportPdf.cjs");
const packageJson = require("../package.json");

if (!app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch("enable-print-browser");

// Set by the first-run setup (flora-node.json): the Leaf API this machine runs, on loopback.
let API_BASE_URL = String(process.env.FLORA_API_BASE_URL || "http://127.0.0.1:6893").replace(/\/+$/, "");
const EDITION_CODE = String(process.env.FLORA_EDITION || packageJson.floraEdition || "full").toLowerCase();
const PRODUCT_NAME = EDITION_CODE === "eforl" ? "Flora EforL" : EDITION_CODE === "rcat" ? "Flora RCAT" : "Flora iCIS";
const APP_ID = EDITION_CODE === "eforl" ? "com.flora.eforl.desktop" : EDITION_CODE === "rcat" ? "com.flora.rcat.desktop" : "com.flora.desktop";
const iconPath = path.join(__dirname, "assets", process.platform === "win32" ? "floraicon.ico" : "floraicon.png");
const generatedPreviewFiles = new Set();
let mainWindow = null;
let tray = null;
let quitting = false;
let serialController = null;
const nativeSupervisor = new installer.native.Supervisor((line) => console.log(line));
const dataDir = () => app.getPath("userData");
const nodeState = () => installer.readState(dataDir());

if (process.platform === "win32") app.setAppUserModelId(APP_ID);

function sanitizeFileBaseName(value) {
  return String(value || "flora-report").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "flora-report";
}

function checkApi() {
  return new Promise(resolve => {
    const request = http.get(`${API_BASE_URL}/health`, { timeout: 2500 }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        try {
          const health = JSON.parse(body);
          resolve(response.statusCode === 200 && health.status === "OK" && health.data_ready !== false);
        } catch { resolve(false); }
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve(false));
  });
}

async function systemStatus() {
  const ready = await checkApi();
  return {
    phase: ready ? "ready" : "bootstrap", backendState: ready ? "running" : "error", ready,
    lastError: ready ? "" : "Flora system is unavailable", lastHealthFailure: ready ? "" : `Cannot reach ${API_BASE_URL}`,
    lastExitDetail: "", dbPath: "", dbExists: ready, dataMode: "local", dbWalExists: false, dbShmExists: false,
    ivyReadUrl: "", ivyHealthUrl: "", ivyState: "unknown", healthUrls: [`${API_BASE_URL}/health`],
    uncleanRecoveryApplied: false, lastRecoveryAction: "", logs: [], updatedAt: Date.now(),
  };
}

// ------------------------------------------------------------------ first-run setup and installed nodes
function setupLog(line) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("flora:setup:log", line);
}

async function createSetupWindow() {
  const win = new BrowserWindow({
    width: 860, height: 900, minWidth: 720, minHeight: 640, autoHideMenuBar: true, title: `${PRODUCT_NAME} — setup`,
    icon: fs.existsSync(iconPath) ? iconPath : undefined, show: false,
    webPreferences: { preload: path.join(__dirname, "setup", "setup-preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  await win.loadFile(path.join(__dirname, "setup", "setup.html"));
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
}

function applyState(state) {
  if (state && state.leaf && state.leaf.apiPort) API_BASE_URL = `http://127.0.0.1:${state.leaf.apiPort}`;
}

// The native serial-controller (COM ports) of a Windows gateway: Docker cannot pass COM ports in.
function superviseSerialController(state) {
  const gw = state && state.gateway;
  const exe = path.join(process.resourcesPath || "", "serial-controller.exe");
  if (!gw || process.platform !== "win32" || !fs.existsSync(exe) || serialController) return;
  const env = fs.readFileSync(path.join(gw.dir, ".env"), "utf8");
  const dbPassword = (env.match(/^FLORA_GATEWAY_DB_PASSWORD=(.*)$/m) || [])[1] || "";
  const logs = path.join(gw.dir, "logs"); fs.mkdirSync(logs, { recursive: true });
  const start = () => {
    if (quitting) return;
    const out = fs.openSync(path.join(logs, "serial-controller.log"), "a");
    serialController = spawn(exe, [], { windowsHide: true, stdio: ["ignore", out, out], env: { ...process.env,
      FLORA_GATEWAY_CONFIG: path.join(gw.dir, "config", "gateway.toml"), FLORA_KAFKA_BROKERS: "127.0.0.1:7414",
      FLORA_GATEWAY_ID: gw.nodeId, RUST_LOG: "info",
      FLORA_GATEWAY_DATABASE_URL: `postgresql://flora_gateway:${dbPassword}@127.0.0.1:7412/flora_gateway` } });
    serialController.on("exit", () => { serialController = null; if (!quitting) setTimeout(start, 5000); });
  };
  start();
}

function ensureTray(state) {
  if (tray || !(state && state.gateway)) return;
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, "assets", "floraicon.png"));
  tray.setToolTip(`${PRODUCT_NAME} — gateway running`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${PRODUCT_NAME}`, click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else createWindow(); } },
    { label: "Gateway admin page", click: () => shell.openExternal("http://127.0.0.1:7400") },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
}

// With the bundled Windows runtime the Leaf needs no Docker: the setup page skips that check.
ipcMain.handle("flora:setup:check-docker", async () => installer.nativeAvailable()
  ? { ok: true, native: true, server: "built-in" } : installer.checkDocker());
ipcMain.handle("flora:setup:open-external", (_event, url) => shell.openExternal(String(url)));
ipcMain.handle("flora:setup:check-kubernetes", () => installer.checkKubernetes());
ipcMain.handle("flora:setup:install", async (_event, form) => {
  try {
    const roles = new Set(form.roles || []);
    const baseDir = path.join(dataDir(), "nodes");
    const state = { ...(nodeState() || {}), roles: [...roles], installedAt: Date.now() };
    let appliance = null;
    if (roles.has("canopy")) {
      // Canopy + appliance first; Leaf / gateway on this PC then install from that new appliance.
      state.site = await installer.installSite({ root: form.root, code: form.siteCode }, setupLog);
      await installer.exposeOnLan(Object.values(state.site.ports), setupLog);
      appliance = state.site.applianceUrl;
      const first = [roles.has("leaf") && "leaf", roles.has("gateway") && "gateway"].filter(Boolean);
      if (first.length) await installer.approveFirstReleases(state.site, first, setupLog);
    } else if (roles.has("leaf") || roles.has("gateway")) {
      appliance = installer.normaliseAppliance(form.appliance);
    }
    state.appliance = appliance;
    if (roles.has("leaf")) state.leaf = installer.nativeAvailable()
      ? await installer.installLeafNative({ appliance, code: form.leafCode, baseDir }, setupLog, nativeSupervisor)
      : await installer.installLeaf({ appliance, code: form.leafCode, baseDir }, setupLog);
    if (roles.has("gateway")) state.gateway = await installer.installGateway({ appliance, code: form.gatewayCode, baseDir }, setupLog);
    installer.writeState(dataDir(), state);
    if (process.platform === "win32") app.setLoginItemSettings({ openAtLogin: true });
    return { ok: true, site: state.site, leaf: state.leaf, gateway: state.gateway };
  } catch (error) {
    setupLog(`ERROR: ${error.message}`);
    return { ok: false, error: error.message };
  }
});
ipcMain.handle("flora:setup:open-app", async () => {
  const state = nodeState(); applyState(state);
  superviseSerialController(state); ensureTray(state);
  const old = mainWindow; await createWindow(); if (old && !old.isDestroyed()) old.destroy();
  return { ok: true };
});

async function waitForApi(seconds = 120) {
  for (let i = 0; i < seconds / 2; i++) { if (await checkApi()) return true; await new Promise((r) => setTimeout(r, 2000)); }
  return false;
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1680, height: 980, minWidth: 900, minHeight: 640, autoHideMenuBar: true,
    title: PRODUCT_NAME, show: false, icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  const state = nodeState();
  // Keep a gateway running in the tray when the window closes.
  win.on("close", (event) => { if (state && state.gateway && !quitting) { event.preventDefault(); win.hide(); } });
  const devUrl = process.env.FLORA_FRONTEND_URL || process.env.VITE_DEV_SERVER_URL;
  if (state && state.site && !state.leaf) await win.loadURL(`https://127.0.0.1:${state.site.ports.canopy}`);   // Canopy machine
  else if (state && state.gateway && !state.leaf) await win.loadURL("http://127.0.0.1:7400");   // gateway-only machine
  else if (devUrl) await win.loadURL(devUrl);
  else {
    const indexFile = path.join(__dirname, "..", "frontend", "dist", "index.html");
    if (!fs.existsSync(indexFile)) dialog.showErrorBox("Flora frontend not built", `Cannot find ${indexFile}`);
    await win.loadFile(indexFile);
  }
  win.on("closed", () => { if (mainWindow === win) mainWindow = null; });
}

ipcMain.on("flora:app:get-edition-code", event => { event.returnValue = EDITION_CODE; });
ipcMain.on("flora:app:get-product-name", event => { event.returnValue = PRODUCT_NAME; });
ipcMain.on("flora:app:get-version", event => { event.returnValue = app.getVersion(); });
ipcMain.on("flora:app:get-backend-base-url", event => { event.returnValue = API_BASE_URL; });

app.on("certificate-error", (event, _contents, url, _error, _cert, callback) => {
  if (/^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) { event.preventDefault(); callback(true); } else callback(false);
});

app.whenReady().then(async () => {
  ipcMain.handle("flora:bootstrap:get-status", systemStatus);
  ipcMain.handle("flora:bootstrap:retry-start", systemStatus);
  ipcMain.handle("flora:bootstrap:safe-recovery", systemStatus);
  ipcMain.handle("flora:bootstrap:stop-backend", systemStatus);
  ipcMain.handle("flora:app:shutdown", async () => { app.quit(); return { ok: true }; });
  ipcMain.handle("flora:report:print-dialog", async event => new Promise((resolve, reject) => {
    event.sender.print({ silent: false, printBackground: true }, (success, reason) => success ? resolve({ ok: true }) : reject(new Error(reason || "Print cancelled or failed")));
  }));
  ipcMain.handle("flora:report:generate-pdf", async (_event, payload) => {
    const base = sanitizeFileBaseName(payload?.fileBaseName);
    const pdf = await buildReportPdfBuffer(payload?.report);
    return { ok: true, fileName: `${base}.pdf`, pdfBase64: pdf.toString("base64") };
  });
  ipcMain.handle("flora:report:preview-pdf", async (_event, payload) => {
    const outPath = path.join(os.tmpdir(), `${sanitizeFileBaseName(payload?.fileBaseName)}-${Date.now()}.pdf`);
    fs.writeFileSync(outPath, await buildReportPdfBuffer(payload?.report));
    generatedPreviewFiles.add(outPath);
    const error = await shell.openPath(outPath);
    if (error) throw new Error(error);
    return { ok: true, path: outPath };
  });
  const state = nodeState();
  if (!state && !process.env.FLORA_API_BASE_URL) {
    await createSetupWindow();                       // first run: set this machine up from the appliance
  } else {
    applyState(state);
    if (state) {
      await installer.startInstalled(state, (line) => console.log(line), nativeSupervisor).catch((e) => console.error(e));
      superviseSerialController(state); ensureTray(state);
      if (state.leaf) await waitForApi(180);
    }
    await createWindow();
  }
  app.on("activate", async () => { if (!BrowserWindow.getAllWindows().length) await createWindow(); });
});

app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
app.on("before-quit", async (event) => {
  quitting = true; if (serialController) serialController.kill();
  const state = nodeState();
  if (state?.leaf?.native && !nativeSupervisor.stopping) {          // stop the Leaf cleanly (database last)
    event.preventDefault();
    await nativeSupervisor.stopAll();
    await installer.native.stopLeaf({ dir: state.leaf.dir });
    app.quit();
  }
});
app.on("window-all-closed", () => { if (process.platform !== "darwin" && !tray) app.quit(); });
app.on("will-quit", () => { for (const file of generatedPreviewFiles) { try { fs.unlinkSync(file); } catch {} } });
