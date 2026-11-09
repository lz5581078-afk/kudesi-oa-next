import {useEffect,useRef,useState,type ReactNode} from 'react';
import {useAuth} from '../../../auth/AuthContext';
import {formatOaDateTime} from '../../../lib/oaDateTime';
import {jstApi,type ArchiveJob} from './jstApi';
const states:Record<string,string>={pending:'等待禁用',confirming:'禁用结果待回查',success:'禁用已确认',failed:'需人工核对'};
type ArchiveToolbar = (archiveButton: ReactNode) => ReactNode;
export function BundleArchiveHistory({toolbar}: {toolbar: ArchiveToolbar}) {
 const {user}=useAuth();
 return <History key={JSON.stringify([user?.companyId,user?.id,user?.permissions])} toolbar={toolbar}/>;
}
function History({toolbar}: {toolbar: ArchiveToolbar}) {
 const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);const [open,setOpen]=useState(false),[rows,setRows]=useState<ArchiveJob[]>([]),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false);
 useEffect(()=>{if(!open)return;let live=true,loading=false;async function load(){if(loading)return;loading=true;try{const result=await jstApi.archiveJobs();if(live){setRows(result.rows);setError('');}}catch(error){if(live)setError(error instanceof Error?error.message:'归档记录读取失败');}finally{loading=false;}}void load();const timer=setInterval(()=>void load(),5000);return()=>{live=false;clearInterval(timer);};},[open,refresh]);
 return <section className="bundle-archive-history">{toolbar(<button type="button" className="secondary-button" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>归档与聚水潭禁用记录</button>)}{open&&<div className="bundle-archive-panel"><p>OA归档与聚水潭禁用分别记录。结果待确认时仅回查，不重复提交；历史申请和成本记录保留。</p><button type="button" className="secondary-button" onClick={()=>setRefresh(value=>value+1)}>刷新记录</button>{error&&<p role="alert">{error}</p>}<div className="table-scroll"><table className="data-table"><thead><tr><th>组合编码 / 名称</th><th>OA状态</th><th>聚水潭禁用状态</th><th>删除原因 / 操作人</th><th>操作</th></tr></thead><tbody>{rows.map(row=><tr key={row.id}><td>{row.code}<small>{row.name}</small></td><td>已归档删除</td><td><strong>{states[row.status]||row.status}</strong><small>{row.message}</small></td><td>{row.reason}<small>{row.actorName||'未记录'} · {formatOaDateTime(row.createdAt)}</small></td><td>{['failed','confirming'].includes(row.status)&&<button type="button" className="secondary-button" disabled={busy} onClick={()=>{setBusy(true);void jstApi.recheckArchive(row.id).then(()=>{if(alive.current)setRefresh(value=>value+1);}).catch(error=>{if(alive.current)setError(error instanceof Error?error.message:'回查失败');}).finally(()=>{if(alive.current)setBusy(false);});}}>重新核对</button>}</td></tr>)}{!rows.length&&<tr><td colSpan={5}>暂无归档记录</td></tr>}</tbody></table></div></div>}</section>;
}
