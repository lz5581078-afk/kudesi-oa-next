import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChecker } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { FinanceCategoryManager } from './FinanceCategoryManager';
import { clearRefCache } from './RecordForm';
import { resourceApi, type ResourceDto } from './api';

export function ReferenceProductCategoryPicker({ values, onChange, labelNow }: { values: Record<string, unknown>; onChange: (id: number | null) => void; labelNow?: string }) {
 const { user }=useAuth(); const canCreate=!!user&&createChecker(user.permissions)('resource.finance-categories.create');
 const family=values.archiveType==='purchased'?String(values.supplyMode || 'original_purchase'):String(values.archiveType ?? '');
 const [rows,setRows]=useState<ResourceDto[]>([]),[keyword,setKeyword]=useState(''),[error,setError]=useState(''),[manager,setManager]=useState(false),[version,setVersion]=useState(0),[loading,setLoading]=useState(true);
 useEffect(()=>{let alive=true;setLoading(true);setError('');(async()=>{const all:ResourceDto[]=[];for(let page=1;;page++){const r=await resourceApi.list('finance-categories',{page,pageSize:200,tab:family});all.push(...r.items);if(all.length>=r.total||!r.items.length)break;}if(alive)setRows(all.filter(r=>r.status==='active'&&r.data.archiveType===family));})().catch(()=>alive&&setError('分类读取失败，请重试。')).finally(()=>alive&&setLoading(false));return()=>{alive=false;};},[family,version]);
 const byId=new Map(rows.map(r=>[r.id,r]));
 const path=(id:number)=>{const names:string[]=[],seen=new Set<number>();for(let r=byId.get(id);r&&!seen.has(r.id);r=byId.get(Number(r.data.parentId))){seen.add(r.id);names.unshift(r.title);}return names.join(' / ');};
 const leaf=rows.filter(r=>!rows.some(c=>c.data.parentId===r.id));
 const current=Number(values.categoryId)||'';
 const list=leaf.filter(r=>r.id===current||!keyword.trim()||`${path(r.id)} ${r.data.code ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase()));
 return <div className="reference-category-picker"><input type="search" aria-label="搜索分类" placeholder="输入分类名称或标识搜索" value={keyword} onChange={e=>setKeyword(e.target.value)}/><select aria-label="分类" value={current} disabled={loading} onChange={e=>onChange(e.target.value?Number(e.target.value):null)}><option value="">{loading?'分类读取中…':'请选择最末级分类'}</option>{current&&!leaf.some(r=>r.id===current)&&<option value={current}>{labelNow||`#${current}`}</option>}{list.map(r=><option key={r.id} value={r.id}>{path(r.id)}</option>)}</select>{error&&<p role="alert">{error}<button type="button" onClick={()=>setVersion(v=>v+1)}>重试</button></p>}{canCreate&&<button type="button" className="link-button" onClick={()=>setManager(true)}>快速新建分类</button>}{manager&&createPortal(<FinanceCategoryManager target="finance-categories" archiveType={family} selectedId={current||undefined} onPick={id => { if (!rows.some(r => r.data.parentId === id)) onChange(id); }} onChanged={()=>{clearRefCache('finance-categories');setVersion(v=>v+1);}} onClose={()=>setManager(false)}/>,document.body)}</div>;
}
