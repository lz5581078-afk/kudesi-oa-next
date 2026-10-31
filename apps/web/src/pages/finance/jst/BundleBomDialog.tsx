import { useEffect,useState } from 'react';
import { BUNDLE_ROLES } from '@kudesi/shared';
import { resourceApi,type ResourceDto } from '../../../resources/api';
import { useResourceCan } from '../../../resources/RecordDetail';
import { FinanceModal } from '../FinanceModal';
import { Pager } from '../common';
import type { LineInput } from './jstApi';

/** 当前组成与实际保存的发布/取消修订，沿用现有构成修订和验证流程。 */
export function BundleBomDialog({ bundle,onClose,onRevise }: {bundle:ResourceDto;onClose:()=>void;onRevise:()=>void}) {
  const can=useResourceCan('finance-bundles');
  const [current,setCurrent]=useState<ResourceDto[]>([]),[history,setHistory]=useState<ResourceDto[]>([]),[total,setTotal]=useState(0),[page,setPage]=useState(1);
  const [selected,setSelected]=useState<ResourceDto | null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [names,setNames]=useState<Record<string,string>>({});
  useEffect(()=>{let live=true;setLoading(true);setError('');(async()=>{
    const lines:ResourceDto[]=[];
    for(let p=1;;p++){const r=await resourceApi.list('finance-bundle-lines',{fieldKey:'bundleId',fieldValue:bundle.id,page:p,pageSize:200,showHidden:true});lines.push(...r.items);if(lines.length>=r.total || !r.items.length)break;}
    const revisions=await resourceApi.list('finance-bundle-revisions',{fieldKey:'bundleId',fieldValue:bundle.id,page,pageSize:20,showHidden:true});
    if(live){setCurrent(lines);setHistory(revisions.items);setTotal(revisions.total);}
  })().catch(e=>live&&setError((e as Error).message)).finally(()=>live&&setLoading(false));return()=>{live=false;};},[bundle.id,page]);
  let lines:LineInput[]=current.map(r=>r.data as unknown as LineInput);
  let payloadError='';
  if(selected){try{const parsed:unknown=JSON.parse(String(selected.data.payload));if(!Array.isArray(parsed) || parsed.some(line=>!line || typeof line!=='object' || !Number.isFinite(line.qty) || typeof line.role!=='string' || (!Number.isSafeInteger(line.baseCodeId) && !Number.isSafeInteger(line.laborId))))throw new Error();lines=parsed as LineInput[];}catch{lines=[];payloadError='此修订的组成数据不完整，无法读取；当前生效组成不受影响。';}}
  const keys=JSON.stringify(lines.map(l=>({type:l.laborId?'finance-labor-costs':'finance-base-codes',id:l.laborId || l.baseCodeId})).filter(x=>x.id));
  useEffect(()=>{let live=true;const refs=JSON.parse(keys) as Array<{type:string;id:number}>;void Promise.allSettled(refs.map(async ref=>{const row=await resourceApi.get(ref.type,ref.id);return [`${ref.type}:${ref.id}`,row.title] as const;})).then(results=>{if(live)setNames(Object.fromEntries(results.flatMap(r=>r.status==='fulfilled'?[r.value]:[])));});return()=>{live=false;};},[keys]);
  return <FinanceModal title={`组合明细与BOM版本 · ${String(bundle.data.code)}`} onClose={onClose}>
    {payloadError && <p role="alert" className="notice error">{payloadError}</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="between"><h3>{bundle.data.name as string}</h3>{can('edit') && bundle.status!=='archived' && <button type="button" className="primary-button" onClick={onRevise}>修改组成</button>}</div>
    <button type="button" className={selected?'secondary-button':'primary-button'} onClick={()=>setSelected(null)}>当前生效组成</button>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>提交时间</th><th>状态</th><th>修改原因</th><th>操作</th></tr></thead><tbody>{history.map(r=><tr key={r.id}><td>{new Date(r.createdAt).toLocaleString('zh-CN',{hour12:false})}</td><td>{({pending:'待验证',published:'已发布',cancelled:'已取消'} as Record<string,string>)[r.status] ?? r.status}</td><td>{String(r.data.reason || '')}</td><td><button type="button" className="link-button" onClick={()=>setSelected(r)}>查看组成</button></td></tr>)}{!history.length && <tr><td colSpan={4} className="muted">{loading?'正在读取…':'暂无组成修订记录'}</td></tr>}</tbody></table></div>
    <Pager page={page} total={total} pageSize={20} onPage={setPage}/>
    <h3>{selected?`修订 #${selected.id} 的组成`:'当前生效组成'}</h3>
    <div className="table-scroll"><table className="data-table"><thead><tr><th>用途</th><th>组成商品 / 人工</th><th>数量</th><th>单位</th><th>损耗率</th><th>参与聚水潭</th><th>备注</th></tr></thead><tbody>{lines.map((line,i)=>{const type=line.laborId?'finance-labor-costs':'finance-base-codes',id=line.laborId || line.baseCodeId;return <tr key={i}><td>{BUNDLE_ROLES.find(r=>r.value===line.role)?.label ?? line.role}</td><td>{names[`${type}:${id}`] || `${line.laborId?'人工':'基础编码'} #${id}`}</td><td>{line.qty}</td><td>{line.unit || '—'}</td><td>{line.lossRate ?? 0}%</td><td>{line.includeInJst===false?'否':'是'}</td><td>{line.note || '—'}</td></tr>;})}{!lines.length && <tr><td colSpan={7} className="muted">{loading?'正在读取组成…':'没有可读取的组成明细'}</td></tr>}</tbody></table></div>
  </FinanceModal>;
}
