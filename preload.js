const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keyHost', {
  status: () => ipcRenderer.invoke('key:status'),
  attach: (input) => ipcRenderer.invoke('key:attach', input),
  remove: () => ipcRenderer.invoke('key:remove'),
  code: () => ipcRenderer.invoke('key:code'),
  copy: () => ipcRenderer.invoke('key:copy'),
  refreshCopy: () => ipcRenderer.invoke('key:refreshCopy'),
  clearCopy: () => ipcRenderer.invoke('key:clearCopy'),
  syncTime: (force) => ipcRenderer.invoke('time:sync', force),
  timeStatus: () => ipcRenderer.invoke('time:status'),
  swtorState: () => ipcRenderer.invoke('swtor:state'),
  onSwtorState: (callback) => {
    ipcRenderer.removeAllListeners('swtor:state');
    ipcRenderer.on('swtor:state', (_e, state) => callback(state));
  },
  close: () => ipcRenderer.send('window:close'),
  minimize: () => ipcRenderer.send('window:minimize'),
});
