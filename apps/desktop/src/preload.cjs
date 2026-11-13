const { contextBridge, ipcRenderer } = require('electron');
const surface=process.argv.find(arg=>arg.startsWith('--oa-desktop-surface='))?.split('=')[1];
const invoke = (command, value) => ipcRenderer.invoke('oa:desktop', command, value);
contextBridge.exposeInMainWorld('oaDesktop', Object.freeze({
  version: '0.2.8', surface,
  copyText: text => invoke('copyText', text),
  ...(process.platform === 'win32' && surface === 'main' ? {
    readRememberedLogin: () => ipcRenderer.invoke('oa:remember-login', 'read'),
    saveRememberedLogin: value => ipcRenderer.invoke('oa:remember-login', 'save', value),
    forgetRememberedLogin: () => ipcRenderer.invoke('oa:remember-login', 'forget'),
  } : {}),
  openAfterSales: () => invoke('openAfterSales'), retry: () => invoke('retry'),
  openSourceWindow: () => invoke('openSourceWindow'),
  jushuitanStatus: () => invoke('jushuitanStatus'),
  ...(surface === 'after-sales' ? {
    openSourceAfterSales: () => invoke('openSourceAfterSales'),
    openOriginalSale: input => invoke('openOriginalSale', input),
    openOriginalOrder: input => invoke('openOriginalOrder', input),
    openOriginalField: input => invoke('openOriginalField', input),
    prepareRecording: input => invoke('prepareRecording', input),
    openOriginalVideo: input => invoke('openOriginalVideo', input),
    getOriginalVideoStatuses: rows => invoke('getOriginalVideoStatuses', rows),
    getOriginalGoodsImages: rows => invoke('getOriginalGoodsImages', rows),
    ...(process.argv.includes('--oa-after-sales-acceptance') ? {
      localAcceptancePage: input => invoke('localAcceptancePage',input),
      localAcceptanceProgress: message => invoke('localAcceptanceProgress',message),
    } : {}),
    readSourcePanel: input => invoke('readSourcePanel', input),
    openOriginalSourcePanel: input => invoke('openOriginalSourcePanel', input),
    readSaleDetail: input => invoke('readSaleDetail', input),
    readOrderDiscount: input => invoke('readOrderDiscount', input),
    readOrderDetail: input => invoke('readOrderDetail', input),
  } : {}),
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
