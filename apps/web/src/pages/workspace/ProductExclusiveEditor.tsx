import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../../api/client';

type Member = {id:number;name:string;active:boolean;departmentName:string|null};
export function ProductExclusiveEditor({id,owners,onSave,onCancel}:{id:number;owners:string[];onSave:(owners:string[])=>void;onCancel:()=>void}) {
  const [members,setMembers]=useState<Member[]>([]);
  const [ready,setReady]=useState(false);
  const [revision,setRevision]=useState(0);
  const [keyword,setKeyword]=useState('');
  const [ownerId,setOwnerId]=useState('');
  const [days,setDays]=useState('365');
  const [reason,setReason]=useState('');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    let active=true;
    setError('');setReady(false);
    api<Member[]>('/org/users').then(rows=>{if(active){setMembers(rows.filter(row=>row.active));setReady(true);}})
      .catch(()=>{if(active)setError('读取公司成员失败，请重试');});
    return()=>{active=false;};
  },[revision]);
  const filtered=members.filter(m=>String(m.id)===ownerId||`${m.name} ${m.departmentName??''}`.includes(keyword.trim()));
  async function save(event:FormEvent){
    event.preventDefault();
    if(busy)return;
    if(!ownerId){setError('请选择公司成员，或选择解除专属');return;}
    if(!reason.trim()){setError('请填写修改原因');return;}
    if(ownerId!=='none'&&(!/^\d+$/.test(days)||Number(days)<1||Number(days)>3650)){setError('专属有效期为1至3650天');return;}
    setBusy(true);setError('');
    try{
      const result=await api<{owners:string[]}>(`/workspace/company-products/${id}/exclusive`,{method:'PATCH',body:{ownerId:ownerId==='none'?null:Number(ownerId),...(ownerId==='none'?{}:{periodDays:Number(days)}),reason:reason.trim()}});
      onSave(result.owners);
    }catch(error){setError(error instanceof ApiError?error.message:'保存失败，请重试');setBusy(false);}
  }
  return <form className="company-product-exclusive" onSubmit={save} aria-label="设置专属人">
    <h3>设置专属人</h3>
    <p>当前专属人：{owners.join('、')||'无'}</p>
    <p className="muted">同一商品归属的规格、马甲和组合共用专属人。保存后立即生效，原记录保留在专属品历史中。</p>
    {!ready&&!error&&<p role="status">正在读取公司成员…</p>}
    <label>搜索成员<input disabled={busy||!ready} value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="姓名或部门" /></label>
    <label>专属人<select disabled={busy||!ready} value={ownerId} onChange={e=>setOwnerId(e.target.value)}>
      <option value="">请选择公司成员</option><option value="none">解除专属（无专属人）</option>
      {filtered.map(m=><option key={m.id} value={m.id}>{m.name} · {m.departmentName??'未分配部门'} · #{m.id}</option>)}
    </select></label>
    {ownerId!=='none'&&<label>专属有效期（天）<input disabled={busy} inputMode="numeric" value={days} onChange={e=>setDays(e.target.value)} /></label>}
    <label>修改原因<textarea disabled={busy} value={reason} maxLength={500} onChange={e=>setReason(e.target.value)} rows={3} /></label>
    {error&&<p role="alert" className="notice error">{error}{!ready&&<button type="button" onClick={()=>setRevision(v=>v+1)}>重试</button>}</p>}
    <div className="company-product-actions"><button type="submit" className="primary-button" disabled={busy||!ready}>{busy?'保存中…':'保存专属人'}</button><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}
