const { contextBridge, ipcRenderer } = require('electron');
// This preload is attached ONLY to the bundled management window. The remote
// collaboration window has no preload, Node, filesystem or native IPC bridge.
contextBridge.exposeInMainWorld('gatherthreadDesktop', Object.freeze({
  action: input => ipcRenderer.invoke('gt-desktop:action', input),
  subscribe: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('gt-desktop:status', listener);
    return () => ipcRenderer.removeListener('gt-desktop:status', listener);
  },
}));
