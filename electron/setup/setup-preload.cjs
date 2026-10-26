const { contextBridge, ipcRenderer } = require("electron");

// Only the first-run setup page gets this bridge (the clinical app keeps window.floraDesktop).
contextBridge.exposeInMainWorld("floraSetup", {
  checkDocker: () => ipcRenderer.invoke("flora:setup:check-docker"),
  checkKubernetes: () => ipcRenderer.invoke("flora:setup:check-kubernetes"),
  install: (form) => ipcRenderer.invoke("flora:setup:install", form),
  openApp: () => ipcRenderer.invoke("flora:setup:open-app"),
  openExternal: (url) => ipcRenderer.invoke("flora:setup:open-external", url),
  onLog: (callback) => ipcRenderer.on("flora:setup:log", (_event, line) => callback(line)),
});
