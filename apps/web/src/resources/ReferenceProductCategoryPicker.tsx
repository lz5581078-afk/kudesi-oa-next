import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createChecker } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { FinanceCategoryManager } from './FinanceCategoryManager';
import { clearRefCache } from './RecordForm';
import { resourceApi, type ResourceDto } from './api';
import { matchesProductCategoryFamily } from './productCategoryFamily';

export function ReferenceProductCategoryPicker({ values, onChange, labelNow }: { values: Record<string, unknown>; onChange: (id: number | null) => void; labelNow?: string }) {
 const { user }=useAuth(); const canCreate=!!user&&createChecker(user.permissions)('resource.finance-categories.create');
 const family=values.archiveType==='purchased'?String(values.supplyMode || 'original_purchase'):String(values.archiveType ?? '');
 const [keyword,setKeyword]=useState(''),[manager,setManager]=useState(false),[version,setVersion]=useState(0);
 const scope=JSON.stringify([user?.companyId,user?.id,user?.permissions,family,version]);
 const [state,setState]=useState<{scope:string;rows:ResourceDto[];error:string;loading:boolean}>({scope:'',rows:[],error:'',loading:true});
 const rows=state.scope===scope?state.rows:[],error=state.scope===scope?state.error:'',loading=state.scope!==scope||state.loading;
 useEffect(()=>{let alive=true;setState({scope,rows:[],error:'',loading:true});(async()=>{
   const all=new Map<number,ResourceDto>();
   for(const tab of family==='supplier_oem'?[family,'original_purchase']:[family]){
     const seen=new Set<number>();let total:number|null=null;
     for(let page=1;alive;page++){
       const result=await resourceApi.list('finance-categories',{page,pageSize:200,tab});if(!alive)return;
       if(!Number.isSafeInteger(result.total)||result.total<0||total!==null&&result.total!==total)throw new Error('分类读取不完整');
       total=result.total;
       for(const row of result.items){if(seen.has(row.id))throw new Error('分类读取不完整');seen.add(row.id);all.set(row.id,row);}
       if(seen.size>total||!result.items.length&&seen.size<total)throw new Error('分类读取不完整');
       if(seen.size===total)break;
     }
   }
   if(alive)setState({scope,rows:[...all.values()].filter(row=>row.status==='active'&&matchesProductCategoryFamily(family,row.data)),error:'',loading:false});
 })().catch(()=>{if(alive)setState({scope,rows:[],error:'分类读取失败，请重试。',loading:false});});return()=>{alive=false;};},[scope,family]);

 const byId=new Map(rows.map(r=>[r.id,r]));
 const path=(id:number)=>{const names:string[]=[],seen=new Set<number>();for(let r=byId.get(id);r&&!seen.has(r.id);r=byId.get(Number(r.data.parentId))){seen.add(r.id);names.unshift(r.title);}return names.join(' / ');};
 const leaf=rows.filter(r=>!rows.some(c=>c.data.parentId===r.id));
 const current=Number(values.categoryId)||'';
 const list=leaf.filter(r=>r.id===current||!keyword.trim()||`${path(r.id)} ${r.data.code ?? ''}`.toLowerCase().includes(keyword.trim().toLowerCase()));
 return <div className="reference-category-picker"><input type="search" aria-label="搜索分类" placeholder="输入分类名称或标识搜索" value={keyword} onChange={e=>setKeyword(e.target.value)}/><select aria-label="分类" value={current} disabled={loading} onChange={e=>onChange(e.target.value?Number(e.target.value):null)}><option value="">{loading?'分类读取中…':'请选择最末级分类'}</option>{current&&!leaf.some(r=>r.id===current)&&<option value={current}>{labelNow||`#${current}`}</option>}{list.map(r=><option key={r.id} value={r.id}>{path(r.id)}</option>)}</select>{error&&<p role="alert">{error}<button type="button" onClick={()=>setVersion(v=>v+1)}>重试</button></p>}{canCreate&&<button type="button" className="link-button" onClick={()=>setManager(true)}>快速新建分类</button>}{manager&&createPortal(<FinanceCategoryManager target="finance-categories" archiveType={family} selectedId={current||undefined} onPick={id => { if (!rows.some(r => r.data.parentId === id)) onChange(id); }} onChanged={()=>{clearRefCache('finance-categories');setVersion(v=>v+1);}} onClose={()=>setManager(false)}/>,document.body)}</div>;
}
