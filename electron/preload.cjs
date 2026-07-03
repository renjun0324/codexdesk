const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexDesk", {
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  readSession: (filePath) => ipcRenderer.invoke("sessions:read", filePath),
  renameSession: (id, title) => ipcRenderer.invoke("sessions:rename", id, title),
  deleteSession: (id, filePath) => ipcRenderer.invoke("sessions:delete", id, filePath),
  exportSession: (filePath) => ipcRenderer.invoke("sessions:export", filePath),
  getUsage: () => ipcRenderer.invoke("usage:get"),
  runCodex: (options) => ipcRenderer.invoke("codex:run", options),
  cancelRun: (runId) => ipcRenderer.invoke("codex:cancel", runId),
  openPath: (targetPath) => ipcRenderer.invoke("shell:openPath", targetPath),
  showItem: (targetPath) => ipcRenderer.invoke("shell:showItem", targetPath),
  onCodexEvent: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on("codex:run-event", handler);
    return () => ipcRenderer.removeListener("codex:run-event", handler);
  }
});
