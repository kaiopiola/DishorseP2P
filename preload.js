const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  getSources: () => ipcRenderer.invoke('get-sources'),
  setChosenSource: (id) => ipcRenderer.invoke('set-chosen-source', id),
});
