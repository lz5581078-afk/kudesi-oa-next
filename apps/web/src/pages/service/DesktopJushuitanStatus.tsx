import {useEffect,useState} from 'react';
import {CheckCircle2, CircleAlert, LogIn} from 'lucide-react';
import type {DesktopBridge, JushuitanStatus} from './desktopBridge';

export function useJushuitanStatus(bridge?:DesktopBridge){
 const probe=bridge?.jushuitanStatus;
 const [status,setStatus]=useState<JushuitanStatus>({state:'checking'});
 useEffect(()=>{
  if(!probe)return;
  let active=true,running=false;
  async function check(){
   if(!active||running)return;
   running=true;
   try{const value=await probe!();if(active)setStatus(value);}
   catch{if(active)setStatus({state:'unavailable'});}
   finally{running=false;}
  }
  void check();
  const timer=setInterval(()=>void check(),4000);
  const onFocus=()=>void check();
  window.addEventListener('focus',onFocus);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',onFocus);};
 },[probe]);
 return probe?status:null;
}

export function DesktopJushuitanStatus({status,onOpen}:{status:JushuitanStatus|null;onOpen?:()=>void}){
 if(!status)return <span className="ds-session">聚水潭 · {onOpen?'此版本无法检测登录态':'请在桌面客户端登录'}</span>;
 if(status.state==='authenticated')return <span className="ds-session ds-session-ready" role="status">
  <CheckCircle2 size={14} aria-hidden="true"/> 聚水潭已登录{status.sourceCompany&&<span> · {status.sourceCompany}</span>}
 </span>;
 if(status.state==='checking')return <span className="ds-session" role="status">正在检测聚水潭登录状态…</span>;
 if(onOpen)return <button type="button" className="ds-session ds-session-login" onClick={onOpen}>
  {status.state==='login_required'?<><LogIn size={14} aria-hidden="true"/> 聚水潭未登录 · 点击登录</>:<><CircleAlert size={14} aria-hidden="true"/> 聚水潭状态未确认 · 打开核对</>}
 </button>;
 return <span className="ds-session" role="status"><CircleAlert size={14} aria-hidden="true"/> {status.state==='login_required'?'聚水潭未登录':'暂无法确认聚水潭登录状态'}</span>;
}