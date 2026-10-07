const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { buildReportPdfBuffer } = require("./reportPdf.cjs");
const packageJson = require("../package.json");

if (!app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch("enable-print-browser");

const API_BASE_URL = String(process.env.FLORA_API_BASE_URL || "http://127.0.0.1:6893").replace(/\/+$/, "");
const EDITION_CODE = String(process.env.FLORA_EDITION || packageJson.floraEdition || "full").toLowerCase();
const PRODUCT_NAME = EDITION_CODE === "eforl" ? "Flora EforL" : EDITION_CODE === "rcat" ? "Flora RCAT" : "ESM Flora";
const APP_ID = EDITION_CODE === "eforl" ? "com.flora.eforl.desktop" : EDITION_CODE === "rcat" ? "com.flora.rcat.desktop" : "com.flora.desktop";
const iconPath = path.join(__dirname, "assets", process.platform === "win32" ? "floraicon.ico" : "floraicon.png");
const generatedPreviewFiles = new Set();
let mainWindow = null;

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

async function createWindow() {
  const win = new BrowserWindow({
    width: 1680, height: 980, minWidth: 900, minHeight: 640, autoHideMenuBar: true,
    title: PRODUCT_NAME, show: false, icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  const devUrl = process.env.FLORA_FRONTEND_URL || process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
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
  await createWindow();
  app.on("activate", async () => { if (!BrowserWindow.getAllWindows().length) await createWindow(); });
});

app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("will-quit", () => { for (const file of generatedPreviewFiles) { try { fs.unlinkSync(file); } catch {} } });
