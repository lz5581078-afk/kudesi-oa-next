import { useAuth } from '../../auth/AuthContext';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
export function RoomQr({id,name}:{id:number;name:string}){
  const {user}=useAuth();
  if(!user)return null;
  const link=`${location.origin}/features/live-desk?room=${id}&company=${user.companyId}`;
  const matrix=qrMatrix(link),graphic=qrSvgPath(matrix);
  return <div className="live-room-qr-panel"><h3>{name} · 飞书扫码上下播</h3><svg className="live-room-qr" width="220" height="220" role="img" aria-label={`${name}上下播二维码`} viewBox={`0 0 ${graphic.size} ${graphic.size}`}><rect width="100%" height="100%" fill="white"/><path d={graphic.path} fill="#111827"/></svg><p>使用本人飞书扫码，核对排班后开始或结束直播。</p><a href={link}>{name}上下播入口</a><p className="muted">此码固定对应直播间，不含登录凭证。可以打印张贴。</p><button type="button" className="secondary-button" onClick={()=>{const w=window.open('','_blank');if(!w)return;const section=document.createElement('section');const heading=document.createElement('h1');heading.textContent=`${name} · 飞书扫码上下播`;section.append(heading);const svg=document.querySelector(`[aria-label="${CSS.escape(name)}上下播二维码"]`);if(svg)section.append(svg.cloneNode(true));const p=document.createElement('p');p.textContent='请使用本人企业飞书扫码，核对信息后上播、下播。';section.append(p);w.document.body.append(section);w.print();}}>打印直播间二维码</button></div>;
}
