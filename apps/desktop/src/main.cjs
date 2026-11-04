'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain, globalShortcut, desktopCapturer, screen, nativeImage, dialog, Menu, Tray } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const {writePngClipboard}=require('./native.cjs');
const { allowedJst, oaOrigin, trustedSender, boundsOf, pngBytes, replaceShortcut } = require('./security.cjs');
const { extractVisible, mergeFrames, openVisibleOrder } = require('./extractor.cjs');
app.setAppUserModelId('com.kudesi.oa.desktop');
let win, view, shot, tray, origin, jstSession, mounted = false, quitting = false;
const popups = new Set();
let accelerator = 'CommandOrControl+Shift+S';
let captureContext = null;
let jstStarted = false;
const icon = path.join(__dirname, '../build/icon.png');
function guardJst(contents) {
  contents.on('will-navigate', (e,url) => { if (!allowedJst(url)) e.preventDefault(); });
  contents.on('will-frame-navigate', (e) => { if (!allowedJst(e.url) && e.url !== 'about:blank') e.preventDefault(); });
  contents.on('will-redirect', (e,url) => { if (!allowedJst(url)) e.preventDefault(); });
  contents.setWindowOpenHandler(({url}) => {
    if (allowedJst(url)) {
      const child = new BrowserWindow({ parent:win, width:1100,height:820,icon,webPreferences:{session:jstSession,sandbox:true,nodeIntegration:false,contextIsolation:true} });
      popups.add(child); child.on('closed',()=>popups.delete(child)); guardJst(child.webContents); child.loadURL(url);
    }
    return {action:'deny'};
  });
}
async function createWindow() {
  origin = oaOrigin(process.env.OA_DESKTOP_URL || 'https://lc.kudesi.com', app.isPackaged);
  jstSession = session.fromPartition('persist:jushuitan');
  jstSession.setPermissionRequestHandler((_,__,callback)=>callback(false));
  jstSession.on('will-download', (_,item) => item.setSaveDialogOptions({defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
  win = new BrowserWindow({width:1560,height:980,minWidth:1080,minHeight:700,icon,backgroundColor:'#f4f7fa',webPreferences:{preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  win.webContents.session.setPermissionRequestHandler((_,__,cb)=>cb(false));
  const allowedOa = url => {
    try { const u=new URL(url); return u.origin===origin || (u.protocol==='https:' && ['accounts.feishu.cn','open.feishu.cn'].includes(u.hostname)); } catch { return false; }
  };
  win.webContents.on('will-navigate',(event,url)=>{ if(!allowedOa(url)) event.preventDefault(); });
  win.webContents.on('will-redirect',(event,url)=>{ if(!allowedOa(url)) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(({url})=>{
    try {const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password){
      const child=new BrowserWindow({parent:win,width:1000,height:800,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
      child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      child.webContents.on('will-navigate',(e,next)=>{if(!next.startsWith('https://'))e.preventDefault();});
      void child.loadURL(url);
    }}catch{/* invalid link */}
    return {action:'deny'};
  });
  win.webContents.on('did-start-navigation',(_,__,___,main)=>{if(main){ mounted=false; view?.setVisible(false); captureContext=null; }});
  view = new WebContentsView({ webPreferences:{session:jstSession,sandbox:true,contextIsolation:true,nodeIntegration:false} });
  win.contentView.addChildView(view); view.setVisible(false); view.webContents.setZoomFactor(0.8); guardJst(view.webContents);
  await win.loadURL(origin+'/');
  win.on('close',e=>{if(!quitting && tray){ e.preventDefault(); win.hide(); }});
  win.on('closed',()=>{view?.webContents.close();win=null;});
  tray = new Tray(nativeImage.createFromPath(icon).resize({width:20,height:20}));
  tray.setToolTip('酷得斯 OA'); tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 OA',click:()=>{win?.show();}},{label:'截图',click:()=>capture().catch(showError)},{type:'separator'},{label:'退出',click:()=>{quitting=true;app.quit();}}]));
  tray.on('double-click',()=>win?.show());
  Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'酷得斯OA',submenu:[{label:'售后工作台',click:()=>win?.loadURL(origin+'/after-sales/workspace')},{label:'刷新 OA',click:()=>win?.webContents.reload()},{label:'截图',click:()=>capture().catch(showError)},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
  try { const config=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'shortcut.json'),'utf8')); accelerator=config.accelerator; } catch { /* first launch */ }
  if(!registerShortcut(accelerator)) showError(new Error('截图快捷键被占用，请在售后工作台重新设置。'));
}
function showError(e) { dialog.showErrorBox('酷得斯 OA', e.message || '操作失败，请重试'); }
function registerShortcut(value) {
  if(!replaceShortcut(globalShortcut,accelerator,value,()=>capture().catch(showError)))return false;
  accelerator=value;return true;
}
async function read() {
  const frames=[];
  for (const contents of [view.webContents,...[...popups].filter(p=>!p.isDestroyed()).map(p=>p.webContents)]) {
    for (const frame of contents.mainFrame.framesInSubtree) {
      if(!allowedJst(frame.url)) continue;
      try { frames.push(await frame.executeJavaScript(`(${extractVisible.toString()})()`)); } catch { /* detached or not yet ready */ }
    }
  }
  return mergeFrames(frames);
}
async function capture() {
  if(shot && !shot.isDestroyed()) {shot.focus();return;}
  const target = captureContext;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size={width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor)};
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:size});
  const source=sources.find(s=>s.display_id===String(display.id)) || (sources.length===1?sources[0]:null);
  if(!source || source.thumbnail.isEmpty()) throw new Error('无法读取屏幕，请在系统隐私设置允许屏幕录制后重试。');
  const image=source.thumbnail.toDataURL();
  shot=new BrowserWindow({...display.bounds,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,fullscreen:process.platform==='darwin',webPreferences:{preload:path.join(__dirname,'shot-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  shot.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  shot.webContents.on('will-navigate',e=>e.preventDefault());
  shot.once('closed',()=>{shot=null;});
  shot.webContents.once('did-finish-load',()=>shot?.webContents.send('shot:image',{image,canAttach:!!target}));
  shot.captureTarget=target;
  await shot.loadFile(path.join(__dirname,'shot.html'));
}
ipcMain.handle('oa:desktop',async(event,command,value)=>{
  if(!trustedSender(event,win,origin)) throw new Error('无权限调用桌面功能');
  switch(command) {
    case 'mount': {if(!jstStarted){jstStarted=true;void view.webContents.loadURL('https://erp321.com/epaas').catch(()=>undefined);}const factor=win.webContents.getZoomFactor();const bounds=boundsOf(value&&Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typeof v==='number'?v*factor:v])),win.getContentSize()); view.setBounds(bounds);mounted=bounds.width>0&&bounds.height>0;view.setVisible(mounted);return true;}
    case 'hide': mounted=false;view.setVisible(false);captureContext=null;return true;
    case 'preferences': return {shortcut:accelerator,registered:globalShortcut.isRegistered(accelerator)};
    case 'refresh': view.webContents.reload();return true;
    case 'zoom': if(![0.6,0.7,0.8,0.9,1].includes(value))throw new Error('无效缩放');view.webContents.setZoomFactor(value);return true;
    case 'read': return read();
    case 'openOrder': {
      if(typeof value!=='string' || !/^\d{4,40}$/.test(value)) throw new Error('订单号无效');
      for (const frame of view.webContents.mainFrame.framesInSubtree) if(allowedJst(frame.url)) {
        const found=await frame.executeJavaScript(`(${openVisibleOrder.toString()})(${JSON.stringify(value)})`);
        if(found)return true;
      }
      throw new Error('当前可见页面未找到此内部订单号，请先在聚水潭列表中定位。');
    }
    case 'context':
      captureContext=value&&Number.isSafeInteger(value.id)&&value.id>0&&/^\d{4,40}$/.test(value.afterSaleId)?{id:value.id,afterSaleId:value.afterSaleId}:null;return true;
    case 'screenshot': {
      captureContext=value&&Number.isSafeInteger(value.id)&&value.id>0&&/^\d{4,40}$/.test(value.afterSaleId)?{id:value.id,afterSaleId:value.afterSaleId}:null;
      await capture();return true;
    }
    case 'shortcut': {
      if(!registerShortcut(value)) throw new Error('快捷键格式无效或已被占用');
      await fs.writeFile(path.join(app.getPath('userData'),'shortcut.json'),JSON.stringify({accelerator:value}));return true;
    }
    case 'clearLogin':
      for(const p of popups)p.close();await jstSession.clearStorageData();await jstSession.clearCache();captureContext=null;await view.webContents.loadURL('https://erp321.com/epaas');return true;
    default: throw new Error('不支持的桌面操作');
  }
});
ipcMain.handle('shot:finish',async(event,{action,image})=>{
  if(!shot || event.sender!==shot.webContents || event.senderFrame!==shot.webContents.mainFrame)throw new Error('无权限');
  if(action==='cancel'){shot.close();return true;}
  const bytes=pngBytes(image), bitmap=nativeImage.createFromBuffer(bytes);
  if(bitmap.isEmpty())throw new Error('截图无效');
  if(action==='copy')await writePngClipboard(bytes);
  else if(action==='save'){
    const result=await dialog.showSaveDialog(shot,{defaultPath:path.join(app.getPath('downloads'),`OA截图-${Date.now()}.png`),filters:[{name:'PNG',extensions:['png']}]});
    if(result.canceled)return false;
    await fs.writeFile(result.filePath,bytes);
  } else if(action==='attach'){
    if(!shot.captureTarget || !win || new URL(win.webContents.getURL()).origin!==origin)throw new Error('请先选择 OA 售后档案');
    await writePngClipboard(bytes);win.webContents.send('oa:screenshot',{...shot.captureTarget,image});win.show();
  }else throw new Error('未知操作');
  shot.close();return true;
});
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{win?.show();win?.focus();});
  app.whenReady().then(createWindow).catch(showError);
}
app.on('before-quit',()=>{quitting=true;});
app.on('will-quit',()=>globalShortcut.unregisterAll());
