import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
import { liveApi, type RoomQrCode } from './liveApi';
import { errText } from './liveFormat';
import './RoomQr.css';

export function RoomQr({id,name}:{id:number;name:string}) {
  const {user}=useAuth();
  const [code,setCode]=useState<RoomQrCode|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState(''),[confirm,setConfirm]=useState(false),[retry,setRetry]=useState(0);
  const svgRef=useRef<SVGSVGElement>(null);
  useEffect(()=>{
    let active=true;setCode(null);setBusy(true);setError('');setConfirm(false);
    liveApi.roomQr(id).then(value=>{if(active)setCode(value);}).catch(e=>{if(active)setError(errText(e));}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[id,retry]);
  async function generate() {
    if(!code||busy)return;
    setBusy(true);setError('');
    try {setCode(await liveApi.generateRoomQr(id,code.version));setConfirm(false);}
    catch(e){setError(errText(e));setConfirm(false);try{setCode(await liveApi.roomQr(id));}catch{setCode(null);}}
    finally{setBusy(false);}
  }
  function print() {
    const w=window.open('','_blank');if(!w)return;
    const section=w.document.createElement('section'),heading=w.document.createElement('h1');
    heading.textContent=`${name} · 上下播二维码`;section.append(heading);
    if(svgRef.current)section.append(svgRef.current.cloneNode(true));
    const p=w.document.createElement('p');p.textContent='请使用本人企业飞书扫码，核对信息后上播或下播。长期有效，重新生成后旧码失效。';section.append(p);
    w.document.body.append(section);w.print();
  }
  if(!user)return null;
  const link=code?.token?`${location.origin}/features/live-desk?room=${id}&company=${user.companyId}&token=${code.token}`:null;
  const graphic=link?qrSvgPath(qrMatrix(link)):null;
  return <section className="live-room-qr-panel" aria-label="上下播二维码">
    <h3>{name} · 上下播二维码</h3>
    <p>上播、下播共用此码。长期有效，重新生成后旧码立即失效。</p>
    {error&&<p role="alert" className="notice error">{error}</p>}
    {busy&&<p role="status">{code?'正在更新二维码…':'正在读取二维码…'}</p>}
    {!busy&&graphic&&<>
      <svg ref={svgRef} className="live-room-qr" width="220" height="220" role="img" aria-label={`${name}上下播二维码`} viewBox={`0 0 ${graphic.size} ${graphic.size}`}><rect width="100%" height="100%" fill="white"/><path d={graphic.path} fill="#111827"/></svg>
      <p><a href={link!}>{name}上下播入口</a></p>
      <p className="muted">使用本人飞书扫码登录，系统按本人状态显示上播或下播。可打印张贴。</p>
    </>}
    {!busy&&code&&!code.token&&<p className="muted">尚未生成二维码，请先生成后张贴到直播间。</p>}
    <div className="live-inline-actions">
      {!code&&!busy&&<button type="button" className="secondary-button" onClick={()=>setRetry(v=>v+1)}>重新读取二维码</button>}
      {link&&<button type="button" className="secondary-button" disabled={busy} onClick={print}>打印二维码</button>}
      {code&&!confirm&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>code.token?setConfirm(true):void generate()}>{code.token?'重新生成二维码':'生成上下播二维码'}</button>}
    </div>
    {confirm&&<div className="notice warning" role="group" aria-label="确认重新生成二维码"><p>重新生成后，已张贴的旧码将立即失效，需要换贴新码。</p><button type="button" className="primary-button" disabled={busy} onClick={()=>void generate()}>确认重新生成</button> <button type="button" className="secondary-button" disabled={busy} onClick={()=>setConfirm(false)}>取消</button></div>}
  </section>;
}
