const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  setChosenSource: (id) => ipcRenderer.invoke('set-chosen-source', id),
});

contextBridge.exposeInMainWorld('appPrefs', {
  get: () => ipcRenderer.invoke('get-prefs'),
  setBackground: (v) => ipcRenderer.invoke('set-background', v),
  setAutostart: (v) => ipcRenderer.invoke('set-autostart', v),
});
