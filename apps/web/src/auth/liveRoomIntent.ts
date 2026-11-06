import { AFTER_SALES_WINDOW_PATH } from '../pages/service/afterSalesWindow';

const KEY='oa.live-room-intent', TIME='oa.live-room-intent-time';
export function liveRoomTarget(value:string):string|null {
  try {
    const url=new URL(value,'https://oa.local');
    if(url.origin!=='https://oa.local'||url.pathname!=='/features/live-desk')return null;
    const room=url.searchParams.get('room'),company=url.searchParams.get('company'),token=url.searchParams.get('token');
    if(token!==null&&!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
    if(!company||!/^\d+$/.test(company)||!Number.isSafeInteger(Number(company))||Number(company)<=0)return null;
    if(room!==null&&(!/^\d+$/.test(room)||!Number.isSafeInteger(Number(room))||Number(room)<=0))return null;
    if(!room&&!token)return null;
    return `/features/live-desk?${room?`room=${Number(room)}&`:''}company=${Number(company)}${token?`&token=${token}`:''}${url.searchParams.get('daily')==='1'?'&daily=1':''}`;
  } catch {return null;}
}
function uploadTarget(value:string) {
  const url=new URL(value,'https://oa.local'), id=url.searchParams.get('upload'), section=url.searchParams.get('section');
  if(url.origin==='https://oa.local' && url.pathname==='/features/live' && url.searchParams.get('tab')==='scripts' && id && /^[1-9]\d{0,9}$/.test(id) && section && ['background','image','video'].includes(section))
    return '/features/live?tab=scripts&upload='+id+'&section='+section;
  return null;
}
function loginTarget(value: string) {
  return value === AFTER_SALES_WINDOW_PATH ? AFTER_SALES_WINDOW_PATH : liveRoomTarget(value) ?? uploadTarget(value);
}
export function rememberLiveRoom() {
  const value=loginTarget(location.pathname+location.search);
  if(value){sessionStorage.setItem(KEY,value);sessionStorage.setItem(TIME,String(Date.now()));}
  else if(location.pathname==='/features/live-desk'&&['room','company','token'].some(key=>new URLSearchParams(location.search).has(key)))clearLiveRoom();
}
export function pendingLiveRoom() {
  if(window.oaDesktop?.surface==='after-sales')return AFTER_SALES_WINDOW_PATH;
  // This timeout only clears an abandoned login redirect; the QR itself has no expiry.
  const time=Number(sessionStorage.getItem(TIME));
  if(!time||Date.now()-time>30*60_000){clearLiveRoom();return '/';}
  const value=sessionStorage.getItem(KEY)??'';return loginTarget(value)??'/';
}
export function consumeLiveRoom(){return pendingLiveRoom();}
export function clearLiveRoom(){sessionStorage.removeItem(KEY);sessionStorage.removeItem(TIME);}

/** 仅飞书内直接扫描的合法上下播链接自动授权；普通登录及授权失败不循环跳转。 */
export function liveScanCompany(userAgent = navigator.userAgent): number | null {
  if (!/Lark|Feishu/i.test(userAgent)) return null;
  const target = liveRoomTarget(location.pathname + location.search);
  return target ? Number(new URL(target, location.origin).searchParams.get('company')) : null;
}
