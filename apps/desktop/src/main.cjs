'use strict';
const { app, BrowserWindow, WebContentsView, session, ipcMain, globalShortcut, desktopCapturer, screen, nativeImage, dialog, Menu, Tray, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {randomUUID}=require('node:crypto');
const {createReader,activeFrame}=require('./after-sales-query.cjs');
const desktopRoutes=require('../build/navigation.json');
const {createRequestWatch}=require('./request-watch.cjs');
const fs = require('node:fs/promises');
const {writePngClipboard}=require('./native.cjs');
const { allowedJst, oaOrigin, allowedOaNavigation, feishuClientLink, isAfterSalesLaunch, trustedSender, boundsOf, pngBytes, replaceShortcut } = require('./security.cjs');
const { extractVisible, mergeFrames, openVisibleOrder } = require('./extractor.cjs');
app.setAppUserModelId('com.kudesi.oa.desktop');
let win, workspace, view, localHost, latestView, collector, localReader, latestReader, shot, tray, origin, jstSession, mounted = false, quitting = false;
const popups = new Set();
let accelerator = 'CommandOrControl+Shift+S';
let captureContext = null,readGeneration=0;
const sourceLoads = new Map();
let requestWatch;
let readyToOpen = false, pendingAfterSales = process.argv.some(isAfterSalesLaunch), pendingMain = false;
let sourceNavigationPending = false, sourceNavigation;
let collectionPreferences={clientId:randomUUID(),enabled:false};
async function ensureView(target){
 const previous=sourceLoads.get(target);
 if(previous)return previous;
 const pending=target.webContents.loadURL('https://erp321.com/epaas').catch(error=>{
  // Epaas replaces its first document with the sign-in page when the local session is empty.
  if(error.code==='ERR_ABORTED'&&allowedJst(target.webContents.getURL()))return;
  throw new Error('聚水潭页面未能加载，请检查网络后刷新。');
 });
 sourceLoads.set(target,pending);
 try{await pending;}
 catch(error){
  if(sourceLoads.get(target)===pending)sourceLoads.delete(target);
  throw error;
 }
}
async function prepare(target){
 await ensureView(target);
 const raw=await target.webContents.mainFrame.executeJavaScript(`(${extractVisible.toString()})()`);
 return {sourceCompany:raw.sourceCompany||''};
}
const icon = path.join(__dirname, '../build/icon.png');
function reloadPage(contents, ignoreCache = false) {
  if (ignoreCache) contents.reloadIgnoringCache();
  else contents.reload();
}
function registerWindowsRefresh(contents, refresh = ignoreCache => reloadPage(contents, ignoreCache)) {
  if (process.platform !== 'win32') return;
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.meta) return;
    const f5 = input.key === 'F5';
    if (!f5 && !(input.control && input.key.toLowerCase() === 'r')) return;
    event.preventDefault();
    refresh(input.control && (f5 || input.shift));
  });
}
function guardJst(contents,background=false) {
  if (!background) registerWindowsRefresh(contents, ignoreCache=>{
    if(mounted&&contents===view?.webContents)sourceNavigationPending=true;
    reloadPage(contents,ignoreCache);
  });
  contents.on('will-navigate', e => { if (!allowedJst(e.url)) e.preventDefault(); });
  const guardFrame=e=>{
    const subframe=e.isMainFrame===false;
    if(!allowedJst(e.url,{subframe})&&!(subframe&&e.url==='about:blank'))e.preventDefault();
  };
  contents.on('will-frame-navigate',guardFrame);
  contents.on('will-redirect',guardFrame);
  contents.setWindowOpenHandler(({url}) => {
    if(!allowedJst(url)&&!(url==='about:blank'&&!background))return {action:'deny'};
    return {action:'allow',overrideBrowserWindowOptions:{
      parent:background ? collector : workspace ?? localHost,show:!background&&mounted,width:1100,height:820,icon,
      webPreferences:{session:jstSession,sandbox:true,nodeIntegration:false,contextIsolation:true},
    }};
  });
  contents.on('did-create-window', child => {
    child.oaBackground=background;
    child.oaReadGeneration=readGeneration;
    popups.add(child);
    child.on('closed',()=>popups.delete(child));
    guardJst(child.webContents,background);
  });
}
const statusPage = path.join(__dirname,'oa-status.html');
const startingOaWindows = new WeakSet();
function refreshOaWindow(target, route, ignoreCache = false) {
  const contents = target.webContents;
  if (contents.getURL().split('?')[0] === pathToFileURL(statusPage).href) {
    if (!contents.isLoadingMainFrame()) void loadOa(target, route).catch(showError);
    return;
  }
  reloadPage(contents, ignoreCache);
}
function rendererPreferences(surface) {
  return {preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,
    additionalArguments:[`--oa-desktop-surface=${surface}`]};
}
function showWindow(target) {
  if(startingOaWindows.has(target))return;
  if(target.isMinimized())target.restore();
  target.show();
  target.focus();
}
function createOaWindow(surface,route) {
  const isWorkspace=surface==='after-sales';
  const target=new BrowserWindow({
    title:isWorkspace?'实时售后处理':'酷得斯 OA',
    show:false,width:isWorkspace?1440:1560,height:980,minWidth:isWorkspace?900:1080,minHeight:700,
    icon,backgroundColor:'#f4f7fa',webPreferences:rendererPreferences(surface),
  });
  startingOaWindows.add(target);
  if(isWorkspace)target.on('page-title-updated',e=>e.preventDefault());
  const contents=target.webContents;
  registerWindowsRefresh(contents, ignoreCache => refreshOaWindow(target, route, ignoreCache));
  const guardOaNavigation = event => {
    if (!allowedOaNavigation(event.url, origin)) event.preventDefault();
  };
  contents.on('will-navigate', guardOaNavigation);
  contents.on('will-redirect', guardOaNavigation);
  contents.setWindowOpenHandler(({url})=>{
    try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password){
      const child=new BrowserWindow({parent:target,width:1000,height:800,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
      registerWindowsRefresh(child.webContents);
      child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      child.webContents.on('will-navigate',e=>{if(!e.url.startsWith('https://'))e.preventDefault();});
      void child.loadURL(url).catch(()=>showError(new Error('附件页面未能加载，请重新获取链接后重试。')));
    }}catch{/* invalid link */}
    return {action:'deny'};
  });
  void loadOa(target,route).catch(showError);
  return target;
}
async function loadOa(target,route) {
  let connected=true;
  try{await target.loadURL(origin+route);}
  catch(error){
    if(target.isDestroyed()||(error.code==='ERR_ABORTED'&&!startingOaWindows.has(target)))return false;
    const surface=route===desktopRoutes.workspace?'after-sales':'main';
    await target.loadFile(statusPage,{query:{surface}});
    connected=false;
  }
  if(!target.isDestroyed()&&startingOaWindows.delete(target))showWindow(target);
  return connected;
}
function openAfterSales() {
  if(workspace&&!workspace.isDestroyed()){showWindow(workspace);return true;}
  const target=createOaWindow('after-sales',desktopRoutes.workspace);
  workspace=target;
  target.webContents.on('did-start-navigation',({isMainFrame,isSameDocument})=>{
    if(isMainFrame&&!isSameDocument)resetWorkspace();
  });
  target.webContents.on('did-navigate-in-page',(_,url,main)=>{
    if(main&&new URL(url).pathname!==desktopRoutes.workspace)resetWorkspace();
  });
  target.on('close',()=>{if(!quitting)resetWorkspace();});
  target.on('closed',()=>{workspace=null;if(!quitting)resetWorkspace();});
  return true;
}
function openMain() {
  if(win&&!win.isDestroyed()){showWindow(win);return;}
  const target=createOaWindow('main','/');
  win=target;
  target.on('close',e=>{if(!quitting && tray){e.preventDefault();target.hide();}});
  target.on('closed',()=>{if(win===target)win=null;});
}
function handleLaunch(args=[]) {
  const afterSales=args.some(isAfterSalesLaunch);
  if(!readyToOpen){
    if(afterSales)pendingAfterSales=true;
    else pendingMain=true;
    return;
  }
  if(afterSales)openAfterSales();
  else openMain();
}
function resetWorkspace() {
  hideSource();
  captureContext=null;
  for(const popup of popups)if(!popup.oaBackground)popup.destroy();
}
async function createWindow() {
  origin=oaOrigin(process.env.OA_DESKTOP_URL||'https://lc.kudesi.com',app.isPackaged);
  if(process.platform==='win32'){
    Menu.setApplicationMenu(null);
  }else{
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'酷得斯OA',submenu:[{label:'实时售后处理',click:()=>openAfterSales()},{label:'刷新当前窗口',click:()=>{
      const target=BrowserWindow.getFocusedWindow();
      if(target && (target===win || target===workspace)) refreshOaWindow(target, target===win ? '/' : desktopRoutes.workspace);
    }},{label:'截图',click:()=>capture().catch(showError)},{role:'quit'}]},{label:'编辑',submenu:[{role:'undo'},{role:'redo'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},{label:'视图',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]}]));
  }
  session.defaultSession.setPermissionRequestHandler((_,__,cb)=>cb(false));
  jstSession=session.fromPartition('persist:jushuitan');
  requestWatch=createRequestWatch(jstSession);
  jstSession.setPermissionRequestHandler((_,__,callback)=>callback(false));
  jstSession.on('will-download',(_,item)=>item.setSaveDialogOptions({defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
  localHost=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
  localHost.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  view = new WebContentsView({ webPreferences:{session:jstSession,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false} });
  view.setBounds({x:0,y:0,width:1440,height:1000});
  localHost.contentView.addChildView(view); view.setVisible(true); view.webContents.setZoomFactor(1); guardJst(view.webContents);
  latestView=new WebContentsView({webPreferences:{session:jstSession,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  latestView.setBounds({x:0,y:0,width:1440,height:1000});
  guardJst(latestView.webContents,true);
  localReader=createReader(view.webContents,()=>ensureView(view),requestWatch.forContents(view.webContents.id));
  latestReader=createReader(latestView.webContents,()=>ensureView(latestView),requestWatch.forContents(latestView.webContents.id));
  const resumeSourceNavigation=()=>{if(mounted&&sourceNavigationPending)void openSourceAfterSales().catch(()=>{});};
  view.webContents.on('did-finish-load',resumeSourceNavigation);
  view.webContents.on('did-navigate-in-page',resumeSourceNavigation);
  try{const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'collection.json'),'utf8'));if(/^[\da-f-]{36}$/i.test(saved.clientId))collectionPreferences={clientId:saved.clientId,enabled:!!saved.enabled,sourceCompany:typeof saved.sourceCompany==='string'?saved.sourceCompany:''};}catch{/* first launch */}
  await fs.writeFile(path.join(app.getPath('userData'),'collection.json'),JSON.stringify(collectionPreferences))
    .catch(error=>console.error('无法保存本机采集设置',error.code));
  // An ordinary OA renderer owns its auth session. The native process never handles OA bearer tokens.
  collector=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{...rendererPreferences('collector'),backgroundThrottling:false}});
  collector.contentView.addChildView(latestView);latestView.setVisible(true);
  collector.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  collector.webContents.on('will-navigate',e=>{try{if(new URL(e.url).origin!==origin)e.preventDefault();}catch{e.preventDefault();}});
  void collector.loadURL(origin+desktopRoutes.collector).catch(error=>console.error('后台售后采集页未能加载',error.code));
  tray = new Tray(nativeImage.createFromPath(icon).resize({width:20,height:20}));
  tray.setToolTip('酷得斯 OA'); tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 OA',click:openMain},{label:'实时售后处理',click:openAfterSales},{label:'截图',click:()=>capture().catch(showError)},{type:'separator'},{label:'退出',click:()=>app.quit()}]));
  tray.on('double-click',openMain);
  try { const config=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'shortcut.json'),'utf8')); accelerator=config.accelerator; } catch { /* first launch */ }
  registerShortcut(accelerator);
  readyToOpen=true;
  if(pendingAfterSales)openAfterSales();
  if(!pendingAfterSales||pendingMain)openMain();
}
function openSourceAfterSales(){
  if(!mounted)return false;
  sourceNavigationPending=true;
  if(!sourceNavigation)sourceNavigation=(async()=>{
    await ensureView(view);
    for(let attempt=0;attempt<20&&mounted&&sourceNavigationPending;attempt++){
      try{
        if(await localReader.openCurrent()){sourceNavigationPending=false;return true;}
      }catch{/* The original site may be navigating after sign-in. */}
      await new Promise(resolve=>setTimeout(resolve,400));
    }
    return false;
  })().finally(()=>{sourceNavigation=undefined;});
  return sourceNavigation;
}
function hideSource(){
  sourceNavigationPending=false;
  for(const popup of popups)if(!popup.oaBackground)popup.hide();
  if(!mounted)return;
  mounted=false;
  if(!view||!localHost||localHost.isDestroyed())return;
  if(workspace&&!workspace.isDestroyed())workspace.contentView.removeChildView(view);
  localHost.contentView.addChildView(view);
  view.setBounds({x:0,y:0,width:1440,height:1000});
}
function showError(e) { dialog.showErrorBox('酷得斯 OA', e.message || '操作失败，请重试'); }
function registerShortcut(value) {
  if(!replaceShortcut(globalShortcut,accelerator,value,()=>capture().catch(showError)))return false;
  accelerator=value;return true;
}
async function read() {
  const frames=[];
  for (const contents of [view.webContents,...[...popups].filter(p=>!p.isDestroyed()&&!p.oaBackground&&p.oaReadGeneration===readGeneration).map(p=>p.webContents)]) {
    for (const frame of contents.mainFrame.framesInSubtree) {
      if(!allowedJst(frame.url)||!await activeFrame(frame)) continue;
      try { frames.push(await frame.executeJavaScript(`(${extractVisible.toString()})()`)); } catch { /* detached or not yet ready */ }
    }
  }
  return mergeFrames(frames);
}
async function capture() {
  if(shot && !shot.isDestroyed()) {shot.focus();return;}
  const target = captureContext&&workspace?{...captureContext,windowId:workspace.id}:null;
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
  if(command==='retry'){
    const target=[win,workspace].find(candidate=>candidate&&!candidate.isDestroyed()&&event.sender===candidate.webContents);
    if(!target||event.senderFrame!==target.webContents.mainFrame||
      event.senderFrame.url.split('?')[0]!==pathToFileURL(statusPage).href)throw new Error('无权限重试 OA');
    return loadOa(target,target===win?'/':desktopRoutes.workspace);
  }
  if(command==='openAfterSales'&&trustedSender(event,win,origin))return openAfterSales();
  if(command==='openFeishuLogin'&&process.platform==='win32'&&trustedSender(event,win,origin)){
    const route=new URL(event.senderFrame.url).pathname;
    if(!['/','/login'].includes(route))throw new Error('请从 OA 登录页发起飞书授权');
    const link=feishuClientLink(value,origin);
    try{await app.getApplicationInfoForProtocol(link);}catch{throw new Error('未找到飞书客户端，请先打开飞书并登录');}
    await shell.openExternal(link);
    return true;
  }
  const foreground=trustedSender(event,workspace,origin)&&new URL(event.senderFrame.url).pathname===desktopRoutes.workspace;
  const background=trustedSender(event,collector,origin)&&new URL(event.senderFrame.url).pathname===desktopRoutes.collector;
  if(!foreground&&!background)throw new Error('无权限调用桌面功能');
  if(background&&!['preferences','prepareLatest','latest'].includes(command))throw new Error('后台采集不可操作原单或桌面');
  if(command==='latest'&&!background)throw new Error('最新协同轮次只能由后台采集器执行');
  switch(command) {
    case 'mount': {
      const factor=workspace.webContents.getZoomFactor();
      const scaled=value&&Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,typeof entry==='number'?entry*factor:entry]));
      const bounds=boundsOf(scaled,workspace.getContentSize());
      if(!bounds.width||!bounds.height){hideSource();return true;}
      if(!mounted){
        localHost.contentView.removeChildView(view);
        workspace.contentView.addChildView(view);
        mounted=true;
        for(const popup of popups)if(!popup.oaBackground)popup.show();
      }
      view.setBounds(bounds);
      await ensureView(view);
      return true;
    }
    case 'hide': hideSource();return true;
    case 'openSourceAfterSales': return openSourceAfterSales();
    case 'preferences': return {shortcut:accelerator,registered:globalShortcut.isRegistered(accelerator),collection:collectionPreferences};
    case 'collection': {
      if(!value||typeof value.enabled!=='boolean'||typeof value.sourceCompany!=='string'||value.sourceCompany.length>100)throw new Error('采集设置无效');collectionPreferences={...collectionPreferences,enabled:value.enabled,sourceCompany:value.sourceCompany.trim()};
      await fs.writeFile(path.join(app.getPath('userData'),'collection.json'),JSON.stringify(collectionPreferences));return true;
    }
    case 'prepare': return prepare(view);
    case 'prepareLatest': return prepare(latestView);
    case 'query': return localReader.query(value,false);
    case 'latest': {
      if(!collectionPreferences.enabled)throw new Error('本机最新采集已停止');
      return latestReader.query(value,true);
    }
    case 'refresh': {
      if(mounted)sourceNavigationPending=true;
      if(sourceLoads.has(view))view.webContents.reload();else await ensureView(view);
      return true;
    }
    case 'zoom': if(![0.6,0.7,0.8,0.9,1].includes(value))throw new Error('无效缩放');view.webContents.setZoomFactor(value);return true;
    case 'read': return read();
    case 'openOrder': {
      readGeneration++;
      if(typeof value!=='string' || !/^\d{4,40}$/.test(value)) throw new Error('订单号无效');
      for (const frame of view.webContents.mainFrame.framesInSubtree) if(allowedJst(frame.url)) {
        const found=await frame.executeJavaScript(`(${openVisibleOrder.toString()})(${JSON.stringify(value)})`,true);
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
      for(const p of popups)p.close();collectionPreferences.enabled=false;await fs.writeFile(path.join(app.getPath('userData'),'collection.json'),JSON.stringify(collectionPreferences));sourceLoads.delete(latestView);await latestView.webContents.loadURL('about:blank');await jstSession.clearStorageData();await jstSession.clearCache();captureContext=null;sourceLoads.delete(view);await ensureView(view);return true;
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
    const {windowId,id,afterSaleId}=shot.captureTarget??{};
    const target=workspace,context=captureContext;
    if(!target||target.id!==windowId||context?.id!==id||context?.afterSaleId!==afterSaleId)
      throw new Error('请先选择截图对应的 OA 售后档案');
    await writePngClipboard(bytes);
    if(target!==workspace||context!==captureContext)
      throw new Error('截图已复制，请在对应档案手动粘贴');
    target.webContents.send('oa:screenshot',{id,afterSaleId,image});
    showWindow(target);
  }else throw new Error('未知操作');
  shot.close();return true;
});
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',(_,argv)=>handleLaunch(argv));
  app.on('open-url',(event,url)=>{
    if(!isAfterSalesLaunch(url))return;
    event.preventDefault();
    handleLaunch([url]);
  });
  app.on('activate',()=>{if(readyToOpen&&!workspace)openMain();});
  if(app.isPackaged&&process.platform==='win32'){
    const scheme=new URL(desktopRoutes.launch).protocol.slice(0,-1);
    if(!app.isDefaultProtocolClient(scheme))app.setAsDefaultProtocolClient(scheme);
  }
  app.whenReady().then(createWindow).catch(showError);
}
app.on('before-quit',()=>{quitting=true;sourceNavigationPending=false;});
app.on('will-quit',()=>{
  globalShortcut.unregisterAll();
  for(const source of [view,latestView])if(source&&!source.webContents.isDestroyed())source.webContents.close();
});
