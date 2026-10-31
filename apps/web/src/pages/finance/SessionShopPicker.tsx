import { useEffect, useState } from 'react';
import { Computer, Search, X } from 'lucide-react';
import type { DeviceRow, SessionClient, StoreCandidate } from './sessionApi';
import { deviceLabel, PLATFORM_LABELS } from './sessionPresentation';

export function AddSessionShops({client,devices,maintenance,onClose,onDone}: {client:SessionClient;devices:DeviceRow[];maintenance:boolean;onClose:()=>void;onDone:()=>void}) {
  const [keyword,setKeyword]=useState(''),[rows,setRows]=useState<StoreCandidate[]>([]),[selected,setSelected]=useState<number[]>([]);
  const [device,setDevice]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState('');
  useEffect(()=>{let alive=true;setLoading(true);const timer=setTimeout(()=>client.available(keyword).then(r=>{if(alive)setRows(r);}).catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setLoading(false);}),200);return()=>{alive=false;clearTimeout(timer);};},[client,keyword]);
  const close=()=>{if(!busy)onClose();};
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&!busy)onClose();};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[busy,onClose]);
  const all=rows.length>0&&rows.every(r=>selected.includes(r.id));
  return <div className="session-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="session-add-title" className="session-modal">
    <header><span>OA 店铺档案</span><h2 id="session-add-title">添加电商平台店铺</h2><p>支持单选或多选，每家店铺在授权电脑上建立独立登录环境。</p><button type="button" aria-label="关闭添加窗口" disabled={busy} onClick={close}><X size={19}/></button></header>
    <div className="session-picker-tools"><label className="session-search"><Search size={16}/><input autoFocus aria-label="搜索可添加店铺" placeholder="搜索平台、运营、店铺名称、编码或平台店铺ID" value={keyword} onChange={e=>setKeyword(e.target.value)}/></label>
      <label className="session-picker-device"><Computer size={16}/>负责电脑<select aria-label="负责电脑" value={device} disabled={busy} onChange={e=>setDevice(e.target.value)}><option value="">请选择电脑</option>{devices.map(d=><option key={d.id} value={d.id}>{deviceLabel(d)} · {d.online?'在线':'离线'}</option>)}</select></label></div>
    {error&&<div className="session-alert" role="alert">{error}</div>}
    <div className="session-candidates"><label className="session-select-all"><input type="checkbox" aria-label="选择当前可添加结果" disabled={busy||loading} checked={all} onChange={e=>setSelected(e.target.checked?[...new Set([...selected,...rows.map(r=>r.id)])].slice(0,100):selected.filter(id=>!rows.some(r=>r.id===id)))}/>选择当前可添加结果<span>共 {rows.length} 家</span></label>
      {loading?<p className="session-empty">正在加载店铺…</p>:rows.length===0?<p className="session-empty">没有可添加的店铺{maintenance?'':'（仅正常状态的店铺可加入提现清单）'}</p>:rows.map(r=><label key={r.id} className={`session-candidate ${selected.includes(r.id)?'selected':''}`}><input type="checkbox" disabled={busy || (selected.length>=100&&!selected.includes(r.id))} checked={selected.includes(r.id)} onChange={e=>setSelected(ids=>e.target.checked?[...ids,r.id]:ids.filter(id=>id!==r.id))}/><div><strong>{PLATFORM_LABELS[r.platform]||r.platform} · {r.name}</strong><small>{r.storeNo||'未设置编码'} · 平台ID {r.platformStoreId||'-'} · 当前运营 {r.operatorName||'-'}</small></div><em>可添加</em></label>)}
    </div>
    <footer><span>已选择 {selected.length} 家 · {device?'已选择负责电脑':'请选择负责电脑'}（每次最多 100 家）</span><button type="button" className="session-secondary" disabled={busy} onClick={close}>取消</button><button type="button" className="session-primary" disabled={busy||!device||!selected.length} onClick={async()=>{setBusy(true);setError('');try{await client.addShops(selected,Number(device));onDone();}catch(e){setError(e instanceof Error?e.message:'添加失败');}finally{setBusy(false);}}}>{busy?'正在添加…':'确认添加'}</button></footer>
  </section></div>;
}
