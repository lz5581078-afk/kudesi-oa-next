import {useExpenseSortPreference} from './ExpenseSortPreference';
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {ClipboardList} from 'lucide-react';
import {api,ApiError} from '../api/client';
import {useAuth} from '../auth/AuthContext';
import {formatOaDateTime} from '../lib/oaDateTime';
import {QueryPanel,QueryTable,type Col} from '../pages/finance/query/QueryKit';
import {FeeSnapshotCreateDialog} from './FeeSnapshotCreateDialog';
import {feeBookingNodes} from './feeBookingPresentation';
import './referenceFeeSnapshots.css';
interface Snap{id:number;name:string;remark:string;categoryCount:number;itemCount:number;createdAt:string}
interface Item{code:string;name:string;category:string;defaultObject?:unknown;relationRequirement?:string}
interface View{id:number;name:string;remark:string;createdAt:string;items:Item[]}
const base='/finance/fee-archive/snapshots';
const when=(value:string)=>formatOaDateTime(value,{seconds:false,empty:''});
/** 原版历史包的表格和内窗，写入仍使用既有快照接口。 */
export function ReferenceFeeSnapshots({canWrite,canDelete,onRestored}:{canWrite:boolean;canDelete:boolean;onRestored:()=>void}){
 const {user}=useAuth();const scope=JSON.stringify([user?.companyId,user?.id,user?.permissions]);
 return <ScopedSnapshots key={scope} identity={scope} canWrite={canWrite} canDelete={canDelete} onRestored={onRestored}/>;
}
function ScopedSnapshots({identity,canWrite,canDelete,onRestored}:{identity:string;canWrite:boolean;canDelete:boolean;onRestored:()=>void}){
 const expenseSort=useExpenseSortPreference();
 const [rows,setRows]=useState<Snap[]|null>(null),[creating,setCreating]=useState(false),[view,setView]=useState<View|null>(null),[confirmation,setConfirmation]=useState<{kind:'restore'|'delete';row:Snap}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const mounted=useRef(false),readSequence=useRef(0),viewSequence=useRef(0),pending=useRef(false);
 const load=async()=>{const request=++readSequence.current;const data=await api<Snap[]>(base);if(mounted.current&&request===readSequence.current)setRows(data);};
 useEffect(()=>{mounted.current=true;void load().catch(e=>{if(mounted.current)setError(e instanceof ApiError?e.message:'加载失败');});return()=>{mounted.current=false;readSequence.current++;viewSequence.current++;};},[]);
 const openView=async(row:Snap)=>{const request=++viewSequence.current;setError('');try{const data=await api<View>(`${base}/${row.id}`);if(mounted.current&&request===viewSequence.current)setView(data);}catch(e){if(mounted.current&&request===viewSequence.current)setError(e instanceof ApiError?e.message:'加载失败');}};
 const cols:Col<Snap>[]=[{key:'name',head:'存档名称',cell:r=><span className="reference-fee-snapshot-name">{r.name||'-'}</span>,csv:r=>r.name},{key:'createdAt',head:'存档时间',cell:r=>when(r.createdAt)||'-',csv:r=>when(r.createdAt)},{key:'categoryCount',head:'分类数',cell:r=>r.categoryCount,csv:r=>r.categoryCount},{key:'itemCount',head:'费用数',cell:r=>r.itemCount,csv:r=>r.itemCount},{key:'remark',head:'备注',cell:r=>r.remark||'-',csv:r=>r.remark},{key:'actions',head:'操作',action:true,cell:r=><div className="reference-fee-snapshot-actions"><button onClick={()=>void openView(r)}>查看</button>{canWrite&&<button onClick={()=>{setError('');setConfirmation({kind:'restore',row:r});}}>恢复</button>}{canDelete&&<button className="danger" onClick={()=>{setError('');setConfirmation({kind:'delete',row:r});}}>删除</button>}</div>}];
 const viewCols:Col<Item>[]=[{key:'code',head:'费用编号',cell:r=>r.code||'-',csv:r=>r.code},{key:'name',head:'费用名称',cell:r=><span className="reference-fee-snapshot-name">{r.name}</span>,csv:r=>r.name},{key:'category',head:'费用分类',cell:r=>r.category||'-',csv:r=>r.category},{key:'defaultObject',head:'挂账节点',cell:r=>feeBookingNodes(r.defaultObject).join('、')||'按业务选择挂账对象',csv:r=>feeBookingNodes(r.defaultObject).join('、')||'按业务选择挂账对象'},{key:'relationRequirement',head:'挂账节点说明',cell:r=>r.relationRequirement||'-',csv:r=>r.relationRequirement}];
 async function confirm(){if(!confirmation||pending.current)return;pending.current=true;setBusy(true);setError('');try{await expenseSort?.flush();if(!mounted.current)return;if(confirmation.kind==='restore')await api(`${base}/${confirmation.row.id}/restore`,{method:'POST',body:{}});else await api(`${base}/${confirmation.row.id}`,{method:'DELETE'});if(!mounted.current)return;const restored=confirmation.kind==='restore';setConfirmation(null);await load();if(mounted.current&&restored){await expenseSort?.reload().catch(()=>{});if(mounted.current)onRestored();}}catch(e){if(mounted.current)setError(e instanceof ApiError?e.message:'操作失败，请重试');}finally{if(mounted.current){pending.current=false;setBusy(false);}}}
 return <div className="reference-fee-snapshots finance-reference-query"><QueryPanel title="费用档案存档表" icon={<ClipboardList size={18}/>} actions={canWrite&&<button type="button" className="secondary-button" onClick={()=>setCreating(true)}>存为历史包</button>}>
 <p className="reference-fee-snapshot-hint">把当前费用档案保存成历史包，后续可以查看或恢复。恢复前系统会自动保存一份当前状态。</p>
 {error&&!confirmation&&<p role="alert">{error}</p>}
 {rows===null?<p role="status">加载中…</p>:rows.length===0?<div className="reference-fee-snapshot-empty"><strong>暂无存档</strong><span>可以先把当前费用档案存成一个历史包。</span></div>:<QueryTable cols={cols} rows={rows} rowKey={r=>r.id} empty="暂无存档" caption="费用档案存档" foot={false} controls={{storageKey:`finance-fee-snapshots.reference24.${identity}`,pageSize:8,boundaryButtons:true,searchPlaceholder:'搜索存档名称或备注'}}/>}
 </QueryPanel>
 {creating&&<FeeSnapshotCreateDialog onClose={()=>setCreating(false)} onCreate={async(name,remark)=>{await api(base,{method:'POST',body:{name,remark:remark||undefined}});if(mounted.current)await load();}}/>}
 {view&&createPortal(<div className="fee-snapshot-create-backdrop"><section className="fee-snapshot-create reference-fee-snapshot-view finance-reference-query" role="dialog" aria-modal="true" aria-label={view.name}><header><div><h2>{view.name}</h2><p>{when(view.createdAt)} · {view.remark||'无备注'}</p></div><button type="button" onClick={()=>{viewSequence.current++;setView(null);}}>关闭</button></header><QueryPanel title="费用类型预览" icon={<ClipboardList size={18}/>}><QueryTable cols={viewCols} rows={view.items} rowKey={r=>view.items.indexOf(r)} empty="暂无资料" caption="费用类型预览" foot={false} controls={{storageKey:`finance-fee-snapshot-view.reference24.${identity}`,pageSize:12,boundaryButtons:true,searchPlaceholder:'搜索费用编号、费用名称或分类'}}/></QueryPanel></section></div>,document.body)}
 {confirmation&&createPortal(<div className="fee-snapshot-create-backdrop"><section className="fee-snapshot-create reference-fee-snapshot-confirm" role="dialog" aria-modal="true" aria-label={confirmation.kind==='restore'?'确认恢复历史包':'删除历史包'}><header><div><h2>{confirmation.kind==='restore'?'确认恢复历史包':'删除历史包'}</h2><p>{confirmation.kind==='restore'?'恢复后当前费用档案会被该历史包替换，系统会先自动保存当前状态。':'删除后这份费用档案存档不会再显示。'}</p></div><button type="button" disabled={busy} onClick={()=>setConfirmation(null)}>关闭</button></header><div className="reference-fee-snapshot-confirm-box"><strong>{confirmation.row.name}</strong><span>{confirmation.kind==='restore'?'请确认是否恢复这份费用档案历史包。':'请确认是否删除这份历史包。'}</span></div>{error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button><button type="button" disabled={busy} className={confirmation.kind==='delete'?'danger':'primary'} onClick={()=>void confirm()}>{confirmation.kind==='restore'?'确认恢复':'确认删除'}</button></footer></section></div>,document.body)}
 </div>;
}
