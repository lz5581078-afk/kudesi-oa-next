const { contextBridge, ipcRenderer } = require('electron');
const surface=process.argv.find(arg=>arg.startsWith('--oa-desktop-surface='))?.split('=')[1];
const invoke = (command, value) => ipcRenderer.invoke('oa:desktop', command, value);
contextBridge.exposeInMainWorld('oaDesktop', Object.freeze({
  version: '0.2.3', surface,
  openAfterSales: () => invoke('openAfterSales'), retry: () => invoke('retry'),
  openSourceWindow: () => invoke('openSourceWindow'),
  ...(surface === 'after-sales' ? { openSourceAfterSales: () => invoke('openSourceAfterSales') } : {}),
  ...(process.platform === 'win32' && surface === 'main' ? { openFeishuLogin: url => invoke('openFeishuLogin', url) } : {}),
  preferences: () => invoke('preferences'), zoom: value => invoke('zoom', value),
  mount: bounds => invoke('mount', bounds), hide: () => invoke('hide'), context: value => invoke('context',value),
  prepare:()=>invoke('prepare'),prepareLatest:()=>invoke('prepareLatest'),
  ...(surface === 'collector' ? {joinCollection: value => invoke('joinCollection', value)} : {}),
  query:value=>invoke('query',value),latest:value=>invoke('latest',value),collection:value=>invoke('collection',value),
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
