import { useCallback, useEffect, useState } from 'react';
import { getResourceDef } from '@kudesi/shared';
import { resourceApi, type ListResult, type ResourceDto } from '../../resources/api';
import { RecordForm, ReasonDialog } from '../../resources/RecordForm';
import { useResourceCan } from '../../resources/RecordDetail';
import { ImportDialog } from '../../resources/ImportDialog';
import { displayValue } from '../../resources/format';
import { downloadText } from '../../resources/csv';
import { Pager } from './common';

/** 版本内的统一资料清单：共用字段、表单与资源 API，锁定版本只读。 */
export function CostVersionRecords({ type,versionId,locked,skuSettingId,onChanged }: {type:string;versionId:number;locked:boolean;skuSettingId?:number;onChanged?:()=>void}) {
  const def = getResourceDef(type)!;
  const global = ['finance-cost-aux-types','finance-cost-production-rates'].includes(type);
  const can = useResourceCan(type);
  const [data,setData] = useState<ListResult | null>(null),[error,setError] = useState('');
  const [page,setPage] = useState(1),[keyword,setKeyword] = useState('');
  const [form,setForm] = useState<{record:ResourceDto | null} | null>(null),[deleting,setDeleting] = useState<ResourceDto | null>(null),[importing,setImporting] = useState(false);
  const scope = {...(global ? {} : {fieldKey:'versionId',fieldValue:versionId}),...(skuSettingId ? {filters:{skuSettingId:String(skuSettingId)}} : {})};
  const load = useCallback(async () => {
    try { setData(await resourceApi.list(type,{page,pageSize:20,keyword:keyword.trim() || undefined,showHidden:true,...(global ? {} : {fieldKey:'versionId',fieldValue:versionId}),...(skuSettingId ? {filters:{skuSettingId:String(skuSettingId)}} : {})}));setError(''); } catch(e) {setError((e as Error).message);}
  },[type,versionId,skuSettingId,page,keyword,global]);
  useEffect(()=>{void load();},[load]);
  const changed = () => {void load();onChanged?.();};
  const columns = def.fields.filter(f=>f.list && f.key !== 'versionId' && f.key !== 'skuSettingId');
  const initial = {...(global ? {} : {versionId}),...(skuSettingId ? {skuSettingId} : {}),qty:1,mode:'add',calculationMethod:'fixed_per_item',costBucket:'production',targetType:'general',priority:100,amount:0,fixedAmount:0,...(type==='finance-cost-production-rates'?{unitAmount:0}:{})};
  return <section className="card cost-version-records" aria-label={def.label}>
    <header className="between"><h2>{def.label}</h2><div className="row-actions">
      {!locked && can('create') && <button type="button" className="primary-button" onClick={()=>setForm({record:null})}>新增{def.label}</button>}
      {!locked && !skuSettingId && can('import') && <button type="button" className="secondary-button" onClick={()=>setImporting(true)}>导入{def.label}</button>}
      {can('export') && <button type="button" className="secondary-button" onClick={async()=>{try{const file=await resourceApi.export(type,true,scope);downloadText(file.filename,file.csv);}catch(e){setError((e as Error).message);}}}>导出</button>}
    </div></header>
    {!locked && !global && <p className="muted">维护辅助成本、分摊或调整后，返回SKU成本并确认自动重算，更新已保存成本。</p>}
    {locked && <p className="muted">此版本已锁定，复制为草稿后可调整成本。</p>}
    {global && <p className="muted">公司各成本版本共用；修改后需预检并确认自动重算，才会更新草稿SKU成本；已锁定版本保留原快照。</p>}
    <div className="toolbar"><input type="search" aria-label={`搜索${def.label}`} placeholder="搜索名称或编码" value={keyword} onChange={e=>{setKeyword(e.target.value);setPage(1);}}/></div>
    {error && <div role="alert" className="notice error">{error}</div>}
    <div className="table-scroll"><table className="data-table"><thead><tr>{columns.map(f=><th key={f.key}>{f.label}</th>)}<th>状态</th><th>操作</th></tr></thead><tbody>
      {data?.items.map(row=><tr key={row.id}>{columns.map(f=><td key={f.key}>{displayValue(f,row)}</td>)}<td>{row.status==='active'?'启用':'停用'}</td><td className="row-actions">
        {!locked && can('edit') && <button type="button" className="link-button" onClick={()=>setForm({record:row})}>编辑</button>}
        {!locked && can('disable') && <button type="button" className="link-button" onClick={async()=>{try{await resourceApi.changeStatus(type,row.id,row.status==='active'?'inactive':'active');changed();}catch(e){setError((e as Error).message);}}}>{row.status==='active'?'停用':'启用'}</button>}
        {!locked && can('delete') && <button type="button" className="link-button danger" onClick={()=>setDeleting(row)}>删除</button>}
        {locked && <span className="muted">已锁定</span>}
      </td></tr>)}
      {data?.items.length===0 && <tr><td colSpan={columns.length+2} className="empty-state muted">暂无{def.label}</td></tr>}
    </tbody></table></div>
    <Pager page={page} total={data?.total ?? 0} pageSize={20} onPage={setPage}/>
    {form && <RecordForm def={def} record={form.record} initial={form.record?.data ?? initial} lockedFields={[...(global?[]:['versionId']),...(skuSettingId?['skuSettingId']:[])]} onClose={()=>setForm(null)} onSaved={()=>{setForm(null);changed();}}/>}
    {importing && <ImportDialog def={def} parentId={global?undefined:versionId} onClose={()=>setImporting(false)} onDone={()=>{setImporting(false);changed();}}/>}
    {deleting && <ReasonDialog title={`删除${def.label}「${deleting.title}」`} confirmLabel="确认删除" danger onClose={()=>setDeleting(null)} onConfirm={async reason=>{await resourceApi.remove(type,deleting.id,reason);setDeleting(null);changed();}}/>}
  </section>;
}
