import { useEffect, useState } from 'react';
import type { LiveChannelInput } from '@kudesi/shared';
import { api } from '../../api/client';
import { qrMatrix, qrSvgPath } from '../../lib/qr';
import { Modal } from './liveUi';
import { ChannelPicker } from './ChannelPicker';
import { ManualProductEditor } from './ManualProductEditor';
import { emptyManualProduct, productEntries } from './liveProducts';
import { errText } from './liveFormat';
import type { Options } from './liveApi';

export function TrialStartDesk(){
  const [open,setOpen]=useState(false);
  return <section className="card"><button className="primary-button" onClick={()=>setOpen(true)}>临时主播开播</button>{open&&<IssueTrialCode close={()=>setOpen(false)}/>}</section>;
}
function IssueTrialCode({close}:{close:()=>void}){
  const [opts,setOpts]=useState<Options|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [room,setRoom]=useState(''),[anchor,setAnchor]=useState(''),[control,setControl]=useState('');
  const [channels,setChannels]=useState<LiveChannelInput[]>([]),[products,setProducts]=useState([emptyManualProduct()]);
  const [link,setLink]=useState('');
  useEffect(()=>{api<Options>('/live/trial-start/options').then(setOpts).catch(e=>setError(errText(e)));},[]);
  async function issue(){
    setBusy(true);setError('');
    try{
      const {token}=await api<{token:string}>('/live/trial-start/issue',{body:{roomId:Number(room),anchorId:Number(anchor),controlId:Number(control),channels,productEntries:productEntries(products)}});
      setLink(location.origin+'/trial-start#'+token);
    } catch(e){setError(errText(e));}finally{setBusy(false);}
  }
  const graphic=link?qrSvgPath(qrMatrix(link)):null;
  return <Modal title="临时主播开播" onClose={close}>
    {error&&<p role="alert">{error}</p>}
    {graphic?<><p>请 {opts?.anchors.find(x=>x.id===Number(anchor))?.name} 用自己的手机扫码，点「确认开播」。二维码 20 分钟内有效，只能使用一次。</p>
      <svg width="220" height="220" role="img" aria-label="临时主播一次性开播码" viewBox={`0 0 ${graphic.size} ${graphic.size}`}><rect width="100%" height="100%" fill="white"/><path d={graphic.path}/></svg>
      <p>主播确认后，指定的中控用本人账号扫直播间固定码，核对本场并登记上播。</p></>:opts?<div className="live-fields">
      {([['直播间',room,setRoom,opts.rooms.filter(x=>!x.live)],['临时主播',anchor,setAnchor,opts.anchors.filter(x=>x.trial&&!x.live)],['本场中控',control,setControl,opts.controls]] as const).map(([label,value,set,rows])=><label className="live-field" key={label}>{label}<select value={value} onChange={e=>set(e.target.value)}><option value="">请选择</option>{rows.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></label>)}
      <ChannelPicker options={opts} value={channels} onChange={setChannels}/><ManualProductEditor products={products} onChange={setProducts}/>
      <button className="primary-button" disabled={busy||!room||!anchor||!control||!channels.length||!productEntries(products).length} onClick={issue}>生成一次性开播码</button>
    </div>:!error&&<p>正在读取直播间和人员…</p>}
  </Modal>;
}

export function TrialStartScan(){
  const [done,setDone]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function confirm(){
    setBusy(true);setError('');
    try{await api('/live/trial-start/confirm',{body:{token:location.hash.slice(1)}});setDone(true);history.replaceState(null,'',location.pathname);}
    catch(e){setError(errText(e));}finally{setBusy(false);}
  }
  return <main className="card pad"><h1>临时主播开播</h1>{done?<p role="status">已登记上播。中控现在可以扫直播间固定码加入本场。</p>:<><p>准备好后点击确认，系统将记录当前时间为你的上播时间。</p><button className="primary-button" disabled={busy} onClick={confirm}>确认开播</button></>}{error&&<p role="alert">{error}</p>}</main>;
}
