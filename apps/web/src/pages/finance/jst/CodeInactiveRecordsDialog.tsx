import { useEffect, useState } from 'react';
import { FinanceModal } from '../FinanceModal';
import { resourceApi, type ListResult } from '../../../resources/api';
import { ApiError } from '../../../api/client';
import { Pager } from '../common';

/** 原停用资料未留下可证明的验证事实，独立维护，不归入任何验证页签。 */
export function CodeInactiveRecordsDialog({type,canEnable,onClose,onChanged}:{type:string;canEnable:boolean;onClose:()=>void;onChanged:()=>void}) {
 const [page,setPage]=useState(1),[revision,setRevision]=useState(0),[data,setData]=useState<ListResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState<number|null>(null);
 useEffect(()=>{let alive=true;setData(null);resourceApi.list(type,{page,pageSize:30,showHidden:true,filters:{verificationState:'unknown',enabledState:'inactive'}}).then(result=>{if(alive){setData(result);setError('');}}).catch(e=>{if(alive)setError(e instanceof ApiError?e.message:'读取失败，请重试');});return()=>{alive=false;};},[type,page,revision]);
 async function enable(id:number){setBusy(id);try{await resourceApi.changeStatus(type,id,'active');onChanged();setRevision(value=>value+1);}catch(e){setError(e instanceof ApiError?e.message:'启用失败');}finally{setBusy(null);}}
 return <FinanceModal title="验证状态待确认的停用记录" onClose={onClose}><p>这些停用资料未记录验证状态。启用后进入待验证，再核对资料。</p>{error&&<p role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>重试</button></p>}<div className="table-scroll"><table className="data-table"><thead><tr><th>编码</th><th>名称</th><th>状态</th><th>操作</th></tr></thead><tbody>{data?.items.map(row=><tr key={row.id}><td>{String(row.data.code??'—')}</td><td>{row.title}</td><td>停用 · 验证状态待确认</td><td>{canEnable&&<button type="button" disabled={busy!==null} onClick={()=>void enable(row.id)}>{busy===row.id?'启用中…':'启用并待验证'}</button>}</td></tr>)}{data&&!data.items.length&&<tr><td colSpan={4}>暂无此类记录</td></tr>}</tbody></table></div><Pager page={page} total={data?.total??0} pageSize={30} onPage={setPage}/></FinanceModal>;
}
