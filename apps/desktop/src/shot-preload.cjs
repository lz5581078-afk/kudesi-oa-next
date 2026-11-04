const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('captureEditor',{
  onImage:fn=>ipcRenderer.once('shot:image',(_,v)=>fn(v)),
  finish:(action,image)=>ipcRenderer.invoke('shot:finish',{action,image}),
});
