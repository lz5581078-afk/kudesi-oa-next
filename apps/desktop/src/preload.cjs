const { contextBridge, ipcRenderer } = require('electron');
const invoke = (command, value) => ipcRenderer.invoke('oa:desktop', command, value);
contextBridge.exposeInMainWorld('oaDesktop', Object.freeze({
  version: '0.1.0', preferences: () => invoke('preferences'), zoom: value => invoke('zoom', value),
  mount: bounds => invoke('mount', bounds), hide: () => invoke('hide'), context: value => invoke('context',value),
  refresh: () => invoke('refresh'), read: () => invoke('read'),
  openOrder: id => invoke('openOrder', id),
  screenshot: context => invoke('screenshot', context),
  shortcut: accelerator => invoke('shortcut', accelerator),
  clearLogin: () => invoke('clearLogin'),
  onScreenshot: callback => {
    const listener = (_, data) => callback(data);
    ipcRenderer.on('oa:screenshot', listener);
    return () => ipcRenderer.removeListener('oa:screenshot', listener);
  },
}));
