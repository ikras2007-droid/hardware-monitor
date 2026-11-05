const { contextBridge, ipcRenderer } = require('electron');

// Экспортируем безопасный API в глобальный объект window браузера
contextBridge.exposeInMainWorld('electronAPI', {
  onCpuData: (callback) => ipcRenderer.on('cpu-data', (_event, value) => callback(value))
});