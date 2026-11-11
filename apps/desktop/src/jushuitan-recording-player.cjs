'use strict';

// The classic list renders the camera beside the sale number as a delegated action.
function classicRecordingAction(afterSaleId, open = false) {
  const visible = element => !!element?.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden' && !element.closest('[hidden],[aria-hidden="true"]');
  const matches = [...document.querySelectorAll('._jt_row')].filter(row =>
    visible(row) && [...row.querySelectorAll('.event_delegation_id')].some(id =>
      visible(id) && id.textContent.trim() === afterSaleId));
  if (matches.length !== 1) return {state:'missing'};

  const controls = [...matches[0].querySelectorAll('.event_delegation_ipcvideo[ipc_info]')]
    .filter(element => visible(element) && element.title === '点击观看视频');
  if (controls.length !== 1) return {state:'missing'};
  const control = controls[0];
  try {
    const info = JSON.parse(control.getAttribute('ipc_info'));
    if (String(info?.biz_id) !== afterSaleId || info.has_ipc_video !== true) return {state:'missing'};
  } catch { return {state:'missing'}; }
  if (!open) return {state:'found'};
  if (globalThis._hasIpcViewPermissions === false) return {state:'denied'};
  if (globalThis.JstPrint?.getJstClientVersion?.() === 0) return {state:'helper-required'};
  control.scrollIntoView?.({block:'center',inline:'center'});
  control.click();
  return {state:'opened'};
}

// Keep the official player in its authenticated iframe and make that frame fill the OA player area.
function focusRecordingFrame(identity) {
  const marker='data-oa-recording-frame';
  if(!identity){
    document.getElementById(marker)?.remove();
    document.querySelector(`[${marker}]`)?.removeAttribute(marker);
    return true;
  }
  const frames=[...document.querySelectorAll('iframe,frame')].filter(frame=>
    frame.getClientRects().length&&getComputedStyle(frame).visibility!=='hidden');
  const named=identity.name&&frames.filter(frame=>frame.name===identity.name);
  const matches=named?.length===1?named:frames.filter(frame=>{
    try{
      const source=new URL(frame.src,location.href);
      return source.origin===identity.origin&&source.pathname===identity.path;
    }catch{return false;}
  });
  if(matches.length!==1||document.getElementById(marker))return false;
  matches[0].setAttribute(marker,'');
  const style=document.createElement('style');
  style.id=marker;
  style.textContent=`body{overflow:hidden!important}body *{visibility:hidden!important}[${marker}]{visibility:visible!important;position:fixed!important;inset:0!important;z-index:2147483647!important;width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;border:0!important;margin:0!important}`;
  document.head.append(style);
  return true;
}

// Called only inside the verified source list frame after a same-row lookup.
async function prepareJushuitanRecording(afterSaleId, locate) {
  const visible=element=>!!element?.getClientRects().length&&getComputedStyle(element).visibility!=='hidden'&&
    !element.closest('[hidden],[aria-hidden="true"]');
  const old=new Set([...document.querySelectorAll('video')].filter(visible));
  if(!locate(afterSaleId,null,true))return {state:'missing'};
  const deadline=Date.now()+6500;
  while(Date.now()<deadline){
    const players=[...document.querySelectorAll('video')].filter(video=>
      !old.has(video)&&visible(video)&&!video.error&&(video.readyState>0||video.currentSrc||
        video.getAttribute('src')||video.srcObject||video.querySelector('source[src]')));
    if(players.length){
      const dialog='[role="dialog"],.ant-modal,.ant-drawer-content,._dialog_panel';
      const roots=[...new Set(players.map(video=>video.closest(dialog)||video.parentElement))];
      if(roots.length!==1)return {state:'external'};
      const root=roots[0];
      root.setAttribute('data-oa-recording-root','');
      const style=document.createElement('style');
      style.id='oa-recording-focus';
      style.textContent='body *{visibility:hidden!important}[data-oa-recording-root],[data-oa-recording-root] *{visibility:visible!important}[data-oa-recording-root]{position:fixed!important;inset:0!important;width:100%!important;max-width:none!important;margin:0!important;overflow:auto!important;z-index:2147483647!important;background:#14191f!important}[data-oa-recording-root] video{display:block;max-width:100%;max-height:100vh;margin:auto}';
      document.head.append(style);
      for(const video of players)video.controls=true;
      return {state:'ready'};
    }
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  return {state:'external'};
}

function dismissJushuitanRecording() {
  document.getElementById('oa-recording-focus')?.remove();
  const root=document.querySelector('[data-oa-recording-root]');
  if(!root)return;
  root.removeAttribute('data-oa-recording-root');
  for(const video of root.querySelectorAll('video'))video.pause();
  root.querySelector('button.ant-modal-close,button.ant-drawer-close,button[aria-label="Close"],button[aria-label="关闭"],._dialog_close_btn')?.click();
}

module.exports={classicRecordingAction,focusRecordingFrame,prepareJushuitanRecording,dismissJushuitanRecording};
