'use strict';
const APP_NAME = '小白OA系统';
const { app, BrowserWindow, WebContentsView, session, ipcMain, globalShortcut, desktopCapturer, screen, nativeImage, dialog, Menu, Tray, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {randomUUID}=require('node:crypto');
const {createReader,activeFrame,legacySnapshot}=require('./after-sales-query.cjs');
const {inspectJushuitanSession}=require('./jushuitan-session.cjs');
const desktopRoutes=require('../build/navigation.json');
const {createRequestWatch}=require('./request-watch.cjs');
const fs = require('node:fs/promises');
const {writePngClipboard}=require('./native.cjs');
const { allowedJst, oaOrigin, allowedOaNavigation, feishuClientLink, isAfterSalesLaunch, isAfterSalesSourceLaunch, trustedSender, boundsOf, pngBytes, replaceShortcut } = require('./security.cjs');
const { extractVisible, mergeFrames, openVisibleOrder } = require('./extractor.cjs');
const {readJushuitanDocument}=require('./jushuitan-document.cjs');
const {readJushuitanOrderDiscount}=require('./jushuitan-order-discount.cjs');
const {focusRecordingFrame,prepareJushuitanRecording,dismissJushuitanRecording}=require('./jushuitan-recording-player.cjs');
const { locateJushuitanField } = require('./jushuitan-source-field.cjs');
const {readGoodsImages,readPublicGoodsImage}=require('./goods-images.cjs');
const {readAfterSalesPanel}=require('./after-sales-panels.cjs');
app.setAppUserModelId('com.kudesi.oa.desktop');
let win, workspace, view, localHost, latestView, collector, localReader, latestReader, shot, tray, origin, jstSession, mounted = false, quitting = false;
let sourceWindow, sourceWindowReader, pendingSource = process.argv.some(isAfterSalesSourceLaunch);
const popups = new Set();
let accelerator = 'CommandOrControl+Shift+S';
let captureContext = null,readGeneration=0;
const sourceLoads = new Map();
const loginRetryAt = new WeakMap();
const sourceReadyAt = new WeakMap();
const sourceRevision = new WeakMap();
const sourceRetryMs = 30000;
let sessionRevision = 0;
let requestWatch;
let readyToOpen = false, pendingAfterSales = process.argv.some(isAfterSalesLaunch), pendingMain = false;
let sourceNavigationPending = false, sourceNavigation;
let collectionPreferences={clientId:randomUUID(),enabled:false,paused:false};
let collectionPreferenceWrites=Promise.resolve();
let foregroundReads=0;
let foregroundRevision=0;
let clearingSource=false;
const recordingStatuses=new Map();
let preparedRecordingFrame;
let preparedRecordingCleanup;
const recordingKey=({sourceCompany,afterSaleId})=>JSON.stringify([sourceCompany,afterSaleId]);
function recordPlaybackIndicators(records){
  const expiresAt=Date.now()+5*60_000;
  for(const record of records){
    const key=recordingKey(record);
    recordingStatuses.delete(key);
    if(record.recordingStatus==='available'||record.recordingStatus==='unavailable'){
      recordingStatuses.set(key,{state:record.recordingStatus,expiresAt});
    }
  }
  while(recordingStatuses.size>1200)recordingStatuses.delete(recordingStatuses.keys().next().value);
}
function currentRecordingStatus(identity){
  const key=recordingKey(identity);
  const entry=recordingStatuses.get(key);
  if(entry&&entry.expiresAt>Date.now())return entry.state;
  recordingStatuses.delete(key);
  return undefined;
}
const collectionYieldMessage='正在查询单笔售后，已让出本机后台采集';
const sourceBusy=()=>clearingSource || foregroundReads>0 || mounted || !!preparedRecordingFrame ||
  (!!sourceWindow&&!sourceWindow.isDestroyed()&&sourceWindow.isFocused());

function saveCollectionPreferences(next){
  collectionPreferences=next;
  const saved=collectionPreferenceWrites.then(()=>
    fs.writeFile(path.join(app.getPath('userData'),'collection.json'),JSON.stringify(next)));
  collectionPreferenceWrites=saved.catch(()=>{});
  return saved;
}

async function runForeground(action){
  foregroundReads++;
  foregroundRevision++;
  try{return await action();}
  finally{foregroundReads--;}
}

async function ensureView(target){
 const previous=sourceLoads.get(target);
 if(previous)return previous;
 const pending=target.webContents.loadURL('https://www.erp321.com/epaas').catch(error=>{
  // Epaas replaces its first document with the sign-in page when the local session is empty.
  if(error.code==='ERR_ABORTED'&&allowedJst(target.webContents.getURL()))return;
  throw new Error('聚水潭页面未能加载，请检查网络后刷新。');
 }).then(()=>{sourceReadyAt.set(target,Date.now());});
 sourceLoads.set(target,pending);
 sourceRevision.set(target,sessionRevision);
 try{await pending;}
 catch(error){
  if(sourceLoads.get(target)===pending)sourceLoads.delete(target);
  throw error;
 }
}
async function inspectSource(target){
  const contents=target.webContents;
  if(contents.isLoadingMainFrame())return {state:'checking'};
  if(!allowedJst(contents.getURL()))return {state:'unavailable'};
  const result=await contents.mainFrame.executeJavaScript(`(${inspectJushuitanSession.toString()})()`);
  if(result.state==='checking'&&Date.now()-(sourceReadyAt.get(target)??0)>15000)return {state:'unavailable'};
  return result;
}
async function sourceStatus(target,{retryLogin=false}={}){
  if(clearingSource)return {state:'checking'};
  try{
    if(retryLogin&&sourceRevision.get(target)!==sessionRevision)sourceLoads.delete(target);
    const wasLoaded=sourceLoads.has(target);
    await ensureView(target);
    let result=await inspectSource(target);
    const retryNeeded=['login_required','unavailable'].includes(result.state);
    if(wasLoaded&&retryLogin&&retryNeeded&&Date.now()-(loginRetryAt.get(target)??0)>sourceRetryMs){
      loginRetryAt.set(target,Date.now());
      sourceLoads.delete(target);
      await ensureView(target);
      result=await inspectSource(target);
    }
    return result;
  }catch{
    return {state:'unavailable'};
  }
}
async function jushuitanStatus(){
  const openSource=sourceWindow&&!sourceWindow.isDestroyed()?sourceWindow:null;
  const status=await sourceStatus(openSource??view,{retryLogin:!openSource&&!sourceBusy()});
  if(openSource&&status.state==='authenticated'&&openSource.oaSourceCompany!==status.sourceCompany){
    openSource.oaSourceCompany=status.sourceCompany;
    sessionRevision++;
    loginRetryAt.delete(view);
    loginRetryAt.delete(latestView);
    void jstSession.cookies.flushStore().catch(()=>{});
  }
  if(openSource&&status.state==='login_required')openSource.oaSourceCompany=undefined;
  return sourceBusy()?{...status,busy:true}:status;
}
async function prepare(target,retryLogin=false,wait=false){
  let status=await sourceStatus(target,{retryLogin});
  const deadline=Date.now()+8000;
  while(wait&&status.state==='checking'&&!clearingSource&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,200));
    status=await sourceStatus(target);
  }
  return {...status,sourceCompany:status.sourceCompany??''};
}
async function prepareCollection(){
 if(sourceBusy()||collectionPreferences.paused)return {sourceCompany:''};
 const result=await prepare(latestView,true);
 if(!result.sourceCompany)return result;
 if(await latestReader.hasCurrent())return result;
 await latestReader.openCurrent();
 return await latestReader.hasCurrent()?result:{sourceCompany:''};
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
function guardJst(contents,background=false,visibleSource) {
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
      parent:visibleSource??(background ? collector : workspace ?? localHost),show:!!visibleSource||(!background&&mounted),width:1100,height:820,icon,
      webPreferences:{session:jstSession,sandbox:true,nodeIntegration:false,contextIsolation:true},
    }};
  });
  contents.on('did-create-window', child => {
    if(visibleSource){guardJst(child.webContents,false,child);return;}
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
function localAcceptance(){
  return !app.isPackaged&&origin==='http://127.0.0.1:5173'&&process.env.OA_AFTER_SALES_ACCEPTANCE==='1';
}
function rendererPreferences(surface) {
  return {preload:path.join(__dirname,'preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,
    additionalArguments:[`--oa-desktop-surface=${surface}`,...(surface==='after-sales'&&localAcceptance()?['--oa-after-sales-acceptance']:[])]};
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
    title:isWorkspace?'实时售后处理':APP_NAME,
    show:false,width:isWorkspace?1440:1560,height:980,minWidth:isWorkspace?900:1080,minHeight:700,
    icon,backgroundColor:'#f4f7fa',webPreferences:rendererPreferences(surface),
  });
  startingOaWindows.add(target);
  target.on('page-title-updated',e=>e.preventDefault());
  const contents=target.webContents;
  registerWindowsRefresh(contents, ignoreCache => refreshOaWindow(target, route, ignoreCache));
  const guardOaNavigation = event => {
    if(isWorkspace&&event.isMainFrame===false){
      try{if(new URL(event.url).origin==='https://m.kuaidi100.com')return;}catch{/* Invalid navigation. */}
    }
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
  if(localAcceptance())target.webContents.on('dom-ready',()=>{
    const route=new URL(target.webContents.getURL()).pathname;
    if(route==='/login')console.log('[售后验收] 本地 OA 等待登录');
  });
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
  if(args.some(isAfterSalesSourceLaunch)){
    if(readyToOpen)openSourceWindow();
    else pendingSource=true;
    return;
  }
  const afterSales=args.some(isAfterSalesLaunch);
  if(!readyToOpen){
    if(afterSales)pendingAfterSales=true;
    else pendingMain=true;
    return;
  }
  if(afterSales)openAfterSales();
  else openMain();
}
function openSourceWindow(autoEnter=true){
  if(clearingSource)return false;
  foregroundRevision++;
  if(sourceWindow&&!sourceWindow.isDestroyed()){
    if(autoEnter)showWindow(sourceWindow);
    return true;
  }
  const target=new BrowserWindow({title:'聚水潭售后',width:1440,height:960,icon,show:autoEnter,
    webPreferences:{session:jstSession,sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  sourceWindow=target;
  const reader=createReader(target.webContents,(wait=true)=>prepare(target,false,wait),requestWatch.forContents(target.webContents.id),recordPlaybackIndicators);
  sourceWindowReader=reader;
  let entering=false;
  const enter=async()=>{
    if(entering||target.oaOpeningSale)return;
    entering=true;
    try{
      for(let attempt=0;attempt<20&&!target.isDestroyed()&&!target.oaOpeningSale;attempt++){
        try{if(await reader.openCurrent())break;}catch{/* login or ERP tabs are still loading */}
        await new Promise(resolve=>setTimeout(resolve,400));
      }
    }finally{entering=false;}
  };
  guardJst(target.webContents,false,target);
  target.on('closed',()=>{
    sourceLoads.delete(target);
    if(sourceWindow===target){sourceWindow=null;sourceWindowReader=null;}
  });
  if(autoEnter){
    target.webContents.on('did-finish-load',()=>{void enter();});
    target.webContents.on('did-navigate-in-page',()=>{void enter();});
  }
  void ensureView(target).catch(e=>{if(!target.isDestroyed())showError(e);});
  return true;
}
async function withOriginalSource(action){
  if(!openSourceWindow(false))throw new Error('聚水潭会话正在清除，请稍后再试');
  const target=sourceWindow;
  const reader=sourceWindowReader;
  target.oaOpeningSale=(target.oaOpeningSale??0)+1;
  try{
    const result=await action(reader);
    if(target.isDestroyed())return false;
    showWindow(target);
    return result;
  }catch(error){
    if(!target.isDestroyed()&&!target.isVisible()&&target.oaOpeningSale===1)target.destroy();
    throw error;
  }finally{target.oaOpeningSale--;}
}
function openOriginalDetail({afterSaleId,internalOrderId,sourceCompany}){
  const kind=internalOrderId?'order':'sale';
  return withOriginalSource(reader=>reader[kind]({afterSaleId,internalOrderId,sourceCompany},async frame=>{
    const args=[internalOrderId||afterSaleId,afterSaleId,kind].map(value=>JSON.stringify(value)).join(',');
    const found=await frame.executeJavaScript(`(${openVisibleOrder.toString()})(${args})`,true);
    if(!found)throw new Error('未找到对应的聚水潭详情入口');
    return true;
  }));
}
function openOriginalField({afterSaleId,sourceCompany,column,action}){
  const activate=reader=>reader.sale({afterSaleId,sourceCompany},async frame=>{
    const args=[afterSaleId,column,false,action??'open'].map(value=>JSON.stringify(value)).join(',');
    const opened=await frame.executeJavaScript(`(${locateJushuitanField.toString()})(${args})`,true);
    if(!opened)throw new Error('聚水潭原列表未显示这笔售后的对应入口');
    return true;
  },{includeHistory:true});
  return action==='attachment'?activate(localReader):withOriginalSource(activate);
}
function runRecordingScript(frame, fn, ...args){
  return frame.executeJavaScript('('+fn.toString()+')(...'+JSON.stringify(args)+')',true);
}
function openOriginalVideo(identity){
  return withOriginalSource(async reader=>{
    const opened=await reader.sale(identity,async frame=>{
      if(currentRecordingStatus(identity)==='unavailable')throw new Error('\u805a\u6c34\u6f6d\u663e\u793a\u8fd9\u7b14\u552e\u540e\u65e0\u5f55\u50cf');
      return runRecordingScript(frame,locateJushuitanField,identity.afterSaleId,null,true);
    },{includeHistory:true});
    if(opened)return true;
    if(currentRecordingStatus(identity)==='available'){
      const result=await reader.classicRecording(identity);
      if(result.state==='helper-required')throw new Error('\u8bf7\u542f\u52a8\u805a\u6c34\u6f6d ERP \u52a9\u624b\u540e\u518d\u64ad\u653e\u5f55\u50cf');
      if(result.state==='denied')throw new Error('\u5f53\u524d\u805a\u6c34\u6f6d\u8d26\u53f7\u6ca1\u6709\u5f55\u50cf\u56de\u653e\u6743\u9650');
      if(result.state==='opened')return true;
    }
    throw new Error('\u805a\u6c34\u6f6d\u672a\u663e\u793a\u8fd9\u7b14\u552e\u540e\u7684\u53ef\u7528\u89c6\u9891\u76d1\u63a7\u5165\u53e3');
  });
}
function recordingScene(frame,afterSaleId){
  if(!allowedJst(frame.url,{subframe:true}))return false;
  const url=new URL(frame.url);
  return url.pathname.replace(/\/$/,'')==='/erp-web-group/erp-oms-ip-camera/scene'&&
    (!url.searchParams.has('bizId')||url.searchParams.get('bizId')===afterSaleId);
}
async function focusClassicRecording(scene){
  const focused=[];
  const restore=()=>Promise.allSettled(focused.map(async frame=>runRecordingScript(frame,focusRecordingFrame,null)));
  try{
    for(let child=scene;child.parent;child=child.parent){
      const parent=child.parent;
      if(!allowedJst(parent.url,{subframe:!!parent.parent}))throw new Error('Untrusted recording frame');
      const {origin,pathname:path}=new URL(child.url);
      if(!await runRecordingScript(parent,focusRecordingFrame,{name:child.name,origin,path}))throw new Error('Recording frame not found');
      focused.push(parent);
    }
    if(focused.length)return restore;
  }catch{await restore();}
}
async function prepareClassicRecording(identity,generation){
  const frames=()=>view.webContents.mainFrame.framesInSubtree;
  const previous=new Map(frames().map(frame=>[frame,frame.url]));
  const result=await localReader.classicRecording(identity);
  if(result.state!=='opened')return result;
  const deadline=Date.now()+7500;
  while(Date.now()<deadline&&generation===readGeneration){
    const scenes=frames().filter(frame=>previous.get(frame)!==frame.url&&recordingScene(frame,identity.afterSaleId));
    if(scenes.length===1){
      const scene=scenes[0];
      const restore=await focusClassicRecording(scene);
      if(!restore)break;
      preparedRecordingFrame=scene;
      preparedRecordingCleanup=async()=>{
        try{await scene.executeJavaScript("document.querySelectorAll('video').forEach(video=>video.pause())");}
        catch{/* The original player closed itself. */}
        await restore();
        sourceLoads.delete(view);
        await ensureView(view).catch(()=>{});
      };
      return {state:'ready',player:'assistant'};
    }
    if(scenes.length>1)break;
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  if(generation===readGeneration){
    sourceLoads.delete(view);
    await ensureView(view).catch(()=>{});
  }
  return {state:'external'};
}
function clearPreparedRecording(){
  const frame=preparedRecordingFrame;
  const cleanup=preparedRecordingCleanup;
  preparedRecordingFrame=undefined;
  preparedRecordingCleanup=undefined;
  if(cleanup)return cleanup();
  if(frame){
    try{return runRecordingScript(frame,dismissJushuitanRecording).catch(()=>{});}
    catch{/* The original source frame has closed. */}
  }
}
async function prepareRecording(identity){
  await clearPreparedRecording();
  const generation=++readGeneration;
  try{
    let result=await localReader.sale(identity,async frame=>{
      if(currentRecordingStatus(identity)==='unavailable')return {state:'unavailable'};
      const script='('+prepareJushuitanRecording.toString()+')('+JSON.stringify(identity.afterSaleId)+','+locateJushuitanField.toString()+')';
      const prepared=await frame.executeJavaScript(script,true);
      if(prepared.state==='ready')preparedRecordingFrame=frame;
      return prepared;
    },{includeHistory:true});
    if(result.state==='missing'&&currentRecordingStatus(identity)==='available'){
      result=await prepareClassicRecording(identity,generation);
      if(result.state==='missing')return {...result,hasRecording:true};
    }
    if(result.state==='ready')recordPlaybackIndicators([{...identity,recordingStatus:'available'}]);
    return result;
  }finally{
    for(const popup of popups)if(popup.oaReadGeneration===generation&&!popup.oaBackground&&!popup.isDestroyed())popup.close();
  }
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
    Menu.setApplicationMenu(Menu.buildFromTemplate([{label:APP_NAME,submenu:[{label:'实时售后处理',click:()=>openAfterSales()},{label:'刷新当前窗口',click:()=>{
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
  localReader=createReader(view.webContents,(retry=true)=>prepare(view,retry&&!mounted,retry),requestWatch.forContents(view.webContents.id),recordPlaybackIndicators);
  latestReader=createReader(latestView.webContents,(retry=true)=>prepare(latestView,retry,retry),requestWatch.forContents(latestView.webContents.id),recordPlaybackIndicators);
  for(const target of [view,latestView])target.webContents.on('did-finish-load',()=>sourceReadyAt.set(target,Date.now()));
  const resumeSourceNavigation=()=>{if(mounted&&sourceNavigationPending)void openSourceAfterSales().catch(()=>{});};
  view.webContents.on('did-finish-load',resumeSourceNavigation);
  view.webContents.on('did-navigate-in-page',resumeSourceNavigation);
  try{
    const saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'collection.json'),'utf8'));
    if(/^[\da-f-]{36}$/i.test(saved.clientId)){
      const sourceCompany=typeof saved.sourceCompany==='string'?saved.sourceCompany:'';
      collectionPreferences={clientId:saved.clientId,enabled:!!saved.enabled,sourceCompany,
        paused:typeof saved.paused==='boolean'?saved.paused:!saved.enabled&&!!sourceCompany,
        companyId:Number.isSafeInteger(saved.companyId)?saved.companyId:undefined};
    }
  }catch{/* first launch */}
  await fs.writeFile(path.join(app.getPath('userData'),'collection.json'),JSON.stringify(collectionPreferences))
    .catch(error=>console.error('无法保存本机采集设置',error.code));
  // An ordinary OA renderer owns its auth session. The native process never handles OA bearer tokens.
  collector=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{...rendererPreferences('collector'),backgroundThrottling:false}});
  collector.contentView.addChildView(latestView);latestView.setVisible(true);
  collector.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  collector.webContents.on('will-navigate',e=>{try{if(new URL(e.url).origin!==origin)e.preventDefault();}catch{e.preventDefault();}});
  if(!localAcceptance())void collector.loadURL(origin+desktopRoutes.collector)
    .catch(error=>console.error('后台售后采集页未能加载',error.code));
  tray = new Tray(nativeImage.createFromPath(icon).resize({width:20,height:20}));
  tray.setToolTip(APP_NAME); tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 OA',click:openMain},{label:'实时售后处理',click:openAfterSales},{label:'截图',click:()=>capture().catch(showError)},{type:'separator'},{label:'退出',click:()=>app.quit()}]));
  tray.on('double-click',openMain);
  try { const config=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'shortcut.json'),'utf8')); accelerator=config.accelerator; } catch { /* first launch */ }
  registerShortcut(accelerator);
  readyToOpen=true;
  if(localAcceptance())pendingAfterSales=true;
  if(pendingAfterSales)openAfterSales();
  if(pendingSource)openSourceWindow();
  if((!pendingAfterSales&&!pendingSource)||pendingMain)openMain();
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
  void clearPreparedRecording();
  sourceNavigationPending=false;
  for(const popup of popups)if(!popup.oaBackground)popup.hide();
  if(!mounted)return;
  mounted=false;
  if(!view||!localHost||localHost.isDestroyed())return;
  if(workspace&&!workspace.isDestroyed())workspace.contentView.removeChildView(view);
  localHost.contentView.addChildView(view);
  view.setBounds({x:0,y:0,width:1440,height:1000});
}
function showError(e) { dialog.showErrorBox(APP_NAME, e.message || '操作失败，请重试'); }
function registerShortcut(value) {
  if(!replaceShortcut(globalShortcut,accelerator,value,()=>capture().catch(showError)))return false;
  accelerator=value;return true;
}
async function read(order) {
  const frames=[];
  for (const contents of [view.webContents,...[...popups].filter(p=>!p.isDestroyed()&&!p.oaBackground&&p.oaReadGeneration===readGeneration).map(p=>p.webContents)]) {
    for (const frame of contents.mainFrame.framesInSubtree) {
      if(!allowedJst(frame.url)||!await activeFrame(frame)) continue;
      try { frames.push(await frame.executeJavaScript(`(${extractVisible.toString()})(${order?JSON.stringify(order):''})`)); } catch { /* detached or not yet ready */ }
    }
  }
  if(!order)return mergeFrames(frames).map(legacySnapshot);
  const {afterSaleId,internalOrderId,sourceCompany}=order;
  return mergeFrames(frames.map(frame=>({sourceCompany,rows:[],detail:frame.detail.filter(record=>
    record.afterSaleId===afterSaleId&&record.internalOrderId===internalOrderId)})))
    .find(record=>record.sourceCompany===sourceCompany)??null;
}
async function openAndReadDocument(frame,identity,kind,discount=false){
  const generation=++readGeneration;
  const {afterSaleId,internalOrderId}=identity;
  const docTitle=kind==='sale'?'售后详情':'订单详情';
  const existingFrames=new Map(view.webContents.mainFrame.framesInSubtree.map(frame=>[frame,frame.url]));
  let detailFrame;
  const imageWait=new Map();
  try{
    const args=[kind==='sale'?afterSaleId:internalOrderId,afterSaleId,kind].map(value=>JSON.stringify(value)).join(',');
    const found=await frame.executeJavaScript(`(${openVisibleOrder.toString()})(${args})`,true);
    if(!found)throw new Error(`未找到这笔售后对应的${docTitle}入口`);
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      const surfaces=[view.webContents,...[...popups].filter(p=>!p.isDestroyed()&&!p.oaBackground&&p.oaReadGeneration===generation).map(p=>p.webContents)];
      for(const contents of surfaces){
        for(const detail of contents.mainFrame.framesInSubtree){
          try{
            if(existingFrames.get(detail)===detail.url||!allowedJst(detail.url)||!await activeFrame(detail))continue;
            const snapshot=await detail.executeJavaScript(`(${readJushuitanDocument.toString()})(${JSON.stringify(identity)},${JSON.stringify(kind)},${readPublicGoodsImage.toString()})`);
            if(snapshot){
              const now=Date.now();
              if(!imageWait.has(detail))imageWait.set(detail,now);
              if(!snapshot.productImages?.length&&snapshot.fields[kind==='sale'?'售后详情商品明细':'商品明细']&&now-imageWait.get(detail)<450)continue;
              detailFrame=detail;
              if(discount){
                const data=await detail.executeJavaScript(`(${readJushuitanOrderDiscount.toString()})()`,true);
                if(!data)return null;
                return {...identity,capturedAt:new Date().toISOString(),fields:{'订单优惠明细':JSON.stringify(data)}};
              }
              return {...snapshot,capturedAt:new Date().toISOString()};
            }
          }catch{/* Wait for the source to finish replacing or loading its frame. */}
        }
      }
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    return null;
  }finally{
    for(const popup of popups)if(popup.oaReadGeneration===generation&&!popup.oaBackground&&!popup.isDestroyed())popup.close();
    if(detailFrame?.parent){
      try{
        const close=(frameName,frameUrl)=>{
          const target=[...document.querySelectorAll('iframe,frame')].find(el=>
            (frameName&&el.name===frameName)||el.src===frameUrl);
          target?.closest('._dialog_panel._float_box')?.querySelector('._dialog_close_btn')?.click();
        };
        await detailFrame.parent.executeJavaScript(`(${close.toString()})(${JSON.stringify(detailFrame.name)},${JSON.stringify(detailFrame.url)})`,true);
      }catch{/* The original detail frame may already have been closed. */}
    }
  }
}
let startingCapture=false;
async function capture(autoAttach=false) {
  if(startingCapture)throw new Error('正在启动截图，请稍候');
  if(shot&&!shot.isDestroyed()){
    shot.focus();
    if(autoAttach)throw new Error('请先完成当前截图');
    return;
  }
  const target=captureContext&&workspace?{...captureContext,windowId:workspace.id,autoAttach}:null;
  if(autoAttach&&!target)throw new Error('请先打开要保存截图的售后');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const size={width:Math.round(display.size.width*display.scaleFactor),height:Math.round(display.size.height*display.scaleFactor)};
  startingCapture=true;
  const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:size})
    .finally(()=>{startingCapture=false;});
  const source=sources.find(s=>s.display_id===String(display.id)) || (sources.length===1?sources[0]:null);
  if(!source || source.thumbnail.isEmpty()) throw new Error('无法读取屏幕，请在系统隐私设置允许屏幕录制后重试。');
  const image=source.thumbnail.toDataURL();
  shot=new BrowserWindow({...display.bounds,frame:false,alwaysOnTop:true,skipTaskbar:true,resizable:false,fullscreen:process.platform==='darwin',webPreferences:{preload:path.join(__dirname,'shot-preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  shot.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  shot.webContents.on('will-navigate',e=>e.preventDefault());
  shot.once('closed',()=>{shot=null;});
  shot.webContents.once('did-finish-load',()=>shot?.webContents.send('shot:image',{image,canAttach:!!target,autoAttach:target?.autoAttach===true}));
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
  const mainWorkspace=trustedSender(event,win,origin)&&new URL(event.senderFrame.url).pathname===desktopRoutes.workspace;
  const background=trustedSender(event,collector,origin)&&new URL(event.senderFrame.url).pathname===desktopRoutes.collector;
  if(!foreground&&!background&&!(mainWorkspace&&['jushuitanStatus','openSourceWindow','query'].includes(command)))throw new Error('无权限调用桌面功能');
  if(background&&!['preferences','prepareLatest','joinCollection','latest','jushuitanStatus'].includes(command))throw new Error('后台采集不可操作原单或桌面');
  if(command==='latest'&&!background)throw new Error('最新协同轮次只能由后台采集器执行');
  switch(command) {
    case 'mount': {
      const factor=workspace.webContents.getZoomFactor();
      const scaled=value&&Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,typeof entry==='number'?entry*factor:entry]));
      const bounds=boundsOf(scaled,workspace.getContentSize());
      if(!bounds.width||!bounds.height){hideSource();return true;}
      if(!mounted){
        foregroundRevision++;
        localHost.contentView.removeChildView(view);
        workspace.contentView.addChildView(view);
        mounted=true;
        if(!preparedRecordingFrame)for(const popup of popups)if(!popup.oaBackground)popup.show();
      }
      view.setBounds(bounds);
      await ensureView(view);
      return true;
    }
    case 'hide': hideSource();return true;
    case 'openSourceAfterSales': return openSourceAfterSales();
    case 'jushuitanStatus': return jushuitanStatus();
    case 'openOriginalSale':
    case 'openOriginalOrder': {
      const order=command==='openOriginalOrder';
      if(!foreground||!value||typeof value.afterSaleId!=='string'||!/^\d{4,40}$/.test(value.afterSaleId)||
        typeof value.sourceCompany!=='string'||!value.sourceCompany.trim()||value.sourceCompany.length>100||
        (order&&(typeof value.internalOrderId!=='string'||!/^\d{4,40}$/.test(value.internalOrderId))))
        throw new Error('原单详情参数无效');
      return runForeground(()=>openOriginalDetail({
        afterSaleId:value.afterSaleId,sourceCompany:value.sourceCompany,
        internalOrderId:order?value.internalOrderId:undefined,
      }));
    }
    case 'getOriginalGoodsImages': {
      if(!foreground||!Array.isArray(value)||value.length>100||value.some(row=>!row||typeof row.afterSaleId!=='string'||!/^\d{4,40}$/.test(row.afterSaleId)||typeof row.sourceCompany!=='string'||!row.sourceCompany.trim()||row.sourceCompany.length>100))throw new Error('商品图片查询参数无效');
      if(clearingSource)return [];
      const result=new Map();
      for(const contents of [view?.webContents,latestView?.webContents,sourceWindow&&!sourceWindow.isDestroyed()?sourceWindow.webContents:null].filter(Boolean)){
        try{
          if(!allowedJst(contents.mainFrame.url))continue;
          const login=await contents.mainFrame.executeJavaScript(`(${inspectJushuitanSession.toString()})()`);
          if(login.state!=='authenticated'||!value.some(row=>row.sourceCompany===login.sourceCompany))continue;
          for(const frame of contents.mainFrame.framesInSubtree){
            if(!allowedJst(frame.url)||!await activeFrame(frame))continue;
            for(const row of await frame.executeJavaScript(`(${readGoodsImages.toString()})(${readPublicGoodsImage.toString()})`)){
              if(value.some(wanted=>wanted.afterSaleId===row.afterSaleId&&wanted.sourceCompany===login.sourceCompany))result.set(recordingKey({...row,sourceCompany:login.sourceCompany}),{...row,sourceCompany:login.sourceCompany});
            }
          }
          const current=await contents.mainFrame.executeJavaScript(`(${inspectJushuitanSession.toString()})()`);
          if(current.sourceCompany!==login.sourceCompany||current.state!=='authenticated')return [];
        }catch{/* A source tab may have been closed or navigated. */}
      }
      return [...result.values()];
    }
    case 'getOriginalVideoStatuses': {
      if(!foreground||!Array.isArray(value)||value.length>100||value.some(row=>
        !row||typeof row.afterSaleId!=='string'||!/^\d{4,40}$/.test(row.afterSaleId)||
        typeof row.sourceCompany!=='string'||!row.sourceCompany.trim()||row.sourceCompany.length>100))
        throw new Error('录像状态查询参数无效');
      return value.flatMap(({afterSaleId,sourceCompany})=>{
        const state=currentRecordingStatus({afterSaleId,sourceCompany});
        return state?[{afterSaleId,sourceCompany,state}]:[];
      });
    }
    case 'prepareRecording':
    case 'openOriginalVideo': {
      if(!foreground||!value||typeof value.afterSaleId!=='string'||!/^\d{4,40}$/.test(value.afterSaleId)||
        typeof value.sourceCompany!=='string'||!value.sourceCompany.trim()||value.sourceCompany.length>100)
        throw new Error('视频监控参数无效');
      const {afterSaleId,sourceCompany}=value;
      return runForeground(()=>command==='prepareRecording'?prepareRecording({afterSaleId,sourceCompany}):openOriginalVideo({afterSaleId,sourceCompany}));
    }
    case 'openOriginalField': {
      if(!foreground||!value||typeof value.afterSaleId!=='string'||!/^\d{4,40}$/.test(value.afterSaleId)||
        typeof value.sourceCompany!=='string'||!value.sourceCompany.trim()||value.sourceCompany.length>100||
        !desktopRoutes.originalFields.includes(value.column)||
        (value.action!==undefined&&(value.action!=='attachment'||!['售后问题登记','供分销备注'].includes(value.column))))
        throw new Error('原字段参数无效');
      const {afterSaleId,sourceCompany,column,action}=value;
      return runForeground(()=>openOriginalField({afterSaleId,sourceCompany,column,action}));
    }
    case 'openOriginalSourcePanel': {
      if(!foreground||!value||!['goods','refund','logs','tracking','shipping','platform','orderAmount','refusal'].includes(value.kind)||typeof value.afterSaleId!=='string'||!/^\d{4,40}$/.test(value.afterSaleId)||typeof value.sourceCompany!=='string'||!value.sourceCompany.trim()||value.sourceCompany.length>100||value.queryProvider!==undefined&&typeof value.queryProvider!=='boolean')throw new Error('原明细参数无效');
      const {afterSaleId,sourceCompany,kind,queryProvider}=value;
      return runForeground(()=>withOriginalSource(reader=>reader.sale({afterSaleId,sourceCompany},async frame=>{
        const result=await frame.executeJavaScript(`(${readAfterSalesPanel.toString()})(${JSON.stringify(afterSaleId)},${JSON.stringify(kind)},${JSON.stringify({keepOpen:true,queryProvider:!!queryProvider})})`,true);
        if(result.error)throw new Error(result.error);
        return result.opened===true;
      })));
    }
    case 'readSourcePanel': {
      if(!foreground)throw new Error('请在实时售后窗口读取明细');
      return runForeground(()=>localReader.panel(value));
    }
    case 'openSourceWindow': return openSourceWindow();
    case 'preferences': return {shortcut:accelerator,registered:globalShortcut.isRegistered(accelerator),collection:collectionPreferences};
    case 'collection': {
      if(!value||typeof value.enabled!=='boolean'||typeof value.sourceCompany!=='string'||value.sourceCompany.length>100)throw new Error('采集设置无效');
      const next={...collectionPreferences,enabled:value.enabled,paused:!value.enabled,sourceCompany:value.sourceCompany.trim()};
      await saveCollectionPreferences(next);
      return true;
    }
    case 'prepare': return prepare(view);
    case 'prepareLatest': return prepareCollection();
    case 'joinCollection': {
      if(!background||!value||!Number.isSafeInteger(value.companyId)||value.companyId<1||
        typeof value.sourceCompany!=='string'||!value.sourceCompany||value.sourceCompany.length>100)return false;
      if(collectionPreferences.companyId&&collectionPreferences.companyId!==value.companyId)return false;
      const {sourceCompany}=await prepareCollection();
      if(sourceCompany!==value.sourceCompany||collectionPreferences.paused||sourceBusy()||
        (collectionPreferences.companyId&&collectionPreferences.companyId!==value.companyId))return false;
      const next={...collectionPreferences,companyId:value.companyId,sourceCompany,enabled:true};
      await saveCollectionPreferences(next);
      return true;
    }
    case 'query': return runForeground(()=>localReader.query(value,false));
    case 'localAcceptanceProgress': {
      if(!foreground||!localAcceptance()||typeof value!=='string'||value.length>400)throw new Error('无权限记录本地验收');
      console.log('[售后验收] '+value.replace(/[\r\n]/g,' '));
      return true;
    }
    case 'localAcceptancePage': {
      const hours=72*60*60_000,until=Date.parse(value?.until),from=Date.parse(value?.from);
      if(!foreground||!localAcceptance()||until>Date.now()||until-from!==hours||value.kind!=='current'||value.value!=='')
        throw new Error('仅本地验收可采集最近三天');
      return runForeground(()=>localReader.query({...value,sourceColumns:true},true));
    }
    case 'latest': {
      const revision=foregroundRevision;
      const check=()=>{
        if(sourceBusy()||revision!==foregroundRevision)throw new Error(collectionYieldMessage);
        if(collectionPreferences.paused)throw new Error('本机最新采集已暂停');
      };
      check();
      return latestReader.query(value,true,check);
    }
    case 'refresh': {
      if(mounted)sourceNavigationPending=true;
      if(sourceLoads.has(view))view.webContents.reload();else await ensureView(view);
      return true;
    }
    case 'zoom': if(![0.6,0.7,0.8,0.9,1].includes(value))throw new Error('无效缩放');view.webContents.setZoomFactor(value);return true;
    case 'read': return read();
    case 'readSaleDetail':
    case 'readOrderDetail':
    case 'readOrderDiscount': {
      const kind=command==='readSaleDetail'?'sale':'order';
      if(!foreground||!value||typeof value.afterSaleId!=='string'||!/^\d{4,40}$/.test(value.afterSaleId)||
         typeof value.internalOrderId!=='string'||((kind==='order'||value.internalOrderId)&&!/^\d{4,40}$/.test(value.internalOrderId))||
         typeof value.sourceCompany!=='string'||!value.sourceCompany.trim()||value.sourceCompany.length>100)
        throw new Error('聚水潭详情参数无效');
      const identity={afterSaleId:value.afterSaleId,internalOrderId:value.internalOrderId,sourceCompany:value.sourceCompany};
      const readDetail=frame=>openAndReadDocument(frame,identity,kind,command==='readOrderDiscount');
      return runForeground(()=>kind==='sale'?localReader.sale(identity,readDetail,{includeHistory:true}):localReader.order(identity,readDetail));
    }
    case 'openOrder': {
      readGeneration++;
      if(typeof value!=='string' || !/^\d{4,40}$/.test(value)) throw new Error('订单号无效');
      for (const frame of view.webContents.mainFrame.framesInSubtree) if(allowedJst(frame.url)&&await activeFrame(frame)) {
        const found=await frame.executeJavaScript(`(${openVisibleOrder.toString()})(${JSON.stringify(value)})`,true);
        if(found)return true;
      }
      throw new Error('当前可见页面未找到此内部订单号，请先在聚水潭列表中定位。');
    }
    case 'context':
      captureContext=value&&Number.isSafeInteger(value.id)&&value.id>0&&/^\d{4,40}$/.test(value.afterSaleId)?{id:value.id,afterSaleId:value.afterSaleId}:null;return true;
    case 'screenshot': {
      captureContext=value&&Number.isSafeInteger(value.id)&&value.id>0&&/^\d{4,40}$/.test(value.afterSaleId)?{id:value.id,afterSaleId:value.afterSaleId}:null;
      await capture(value?.autoAttach===true);return true;
    }
    case 'shortcut': {
      if(!registerShortcut(value)) throw new Error('快捷键格式无效或已被占用');
      await fs.writeFile(path.join(app.getPath('userData'),'shortcut.json'),JSON.stringify({accelerator:value}));return true;
    }
    case 'clearLogin':
      if(clearingSource)return false;
      clearingSource=true;
      try{
        foregroundRevision++;
        hideSource();
        sourceWindow?.close();
        for(const popup of popups)popup.close();
        await saveCollectionPreferences({...collectionPreferences,enabled:false});
        await Promise.all([view,latestView].map(async target=>{
          sourceLoads.delete(target);
          await target.webContents.loadURL('about:blank');
        }));
        recordingStatuses.clear();await jstSession.clearStorageData();
        await jstSession.clearCache();
        captureContext=null;
        await ensureView(view);
        return true;
      }finally{clearingSource=false;}
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
    const {windowId,id,afterSaleId,autoAttach}=shot.captureTarget??{};
    const target=workspace,context=captureContext;
    if(!target||target.isDestroyed()||target.id!==windowId||
       (!autoAttach&&(context?.id!==id||context?.afterSaleId!==afterSaleId)))
      throw new Error('请先打开截图对应的 OA 售后档案');
    if(autoAttach)await writePngClipboard(bytes).catch(()=>{});
    else await writePngClipboard(bytes);
    if(target!==workspace||target.isDestroyed()||(!autoAttach&&context!==captureContext))
      throw new Error('截图已复制，请在对应档案手动粘贴');
    target.webContents.send('oa:screenshot',{id,afterSaleId,image,autoAttach});
    showWindow(target);
  }else throw new Error('未知操作');
  shot.close();return true;
});
if(!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',(_,argv)=>handleLaunch(argv));
  app.on('open-url',(event,url)=>{
    if(!isAfterSalesLaunch(url)&&!isAfterSalesSourceLaunch(url))return;
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
