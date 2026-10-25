const { contextBridge, webFrame, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("floraDesktop", {
  isElectron: true,
  platform: process.platform,
  getEditionInfo: () => ({
    code: ipcRenderer.sendSync("flora:app:get-edition-code"),
    productName: ipcRenderer.sendSync("flora:app:get-product-name"),
    version: ipcRenderer.sendSync("flora:app:get-version"),
  }),
  getBackendBaseUrl: () =>
    ipcRenderer.sendSync("flora:app:get-backend-base-url"),
  getLiveBaseUrl: () =>
    ipcRenderer.sendSync("flora:app:get-live-base-url"),
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
  getZoomLevel: () => webFrame.getZoomLevel(),
  getBootstrapStatus: () =>
    ipcRenderer.invoke("flora:bootstrap:get-status"),
  retryBootstrapStart: () =>
    ipcRenderer.invoke("flora:bootstrap:retry-start"),
  runBootstrapSafeRecovery: () =>
    ipcRenderer.invoke("flora:bootstrap:safe-recovery"),
  stopBootstrapBackend: () =>
    ipcRenderer.invoke("flora:bootstrap:stop-backend"),
  onShutdownRequested: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("flora:app:shutdown-request", listener);
    return () => ipcRenderer.removeListener("flora:app:shutdown-request", listener);
  },
  shutdownApp: () =>
    ipcRenderer.invoke("flora:app:shutdown"),
  printReport: () =>
    ipcRenderer.invoke("flora:report:print-dialog"),
  generateReportPdf: (payload) =>
    ipcRenderer.invoke("flora:report:generate-pdf", payload || {}),
  openReportPdfPreview: (payload) =>
    ipcRenderer.invoke("flora:report:preview-pdf", payload || {}),
});
