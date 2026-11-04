import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {createChecker} from '@kudesi/shared';
import {useAuth} from '../auth/AuthContext';
import {FinanceModal} from '../pages/finance/FinanceModal';
import {resourceApi,type ResourceDto} from './api';
import {clearRefCache} from './ResourceReferenceControls';
import {referenceIdentity} from './referenceOptionsCache';
import {feeBookingNodes as nodesOf,feeBookingOptions} from './feeBookingPresentation';
import './feeBookingNodeDialog.css';

const summary=(value:unknown)=>nodesOf(value).join('、')||'按业务选择挂账对象';
export function FeeBookingNodeCell({record,onSaved}:{record:ResourceDto;onSaved?:()=>void}){
 const {user}=useAuth(),scope=referenceIdentity(user),canEdit=!!user&&createChecker(user.permissions)('resource.finance-fee-items.edit');
 const [open,setOpen]=useState(false);
 useEffect(()=>setOpen(false),[scope,record.id]);
 return <>{canEdit&&!record.archived?<button type="button" className="fee-booking-node-cell" aria-label={`修改${record.title}挂账节点`} onClick={event=>{event.stopPropagation();setOpen(true);}}><strong>{summary(record.data.defaultObject)}</strong></button>:<span>{summary(record.data.defaultObject)}</span>}{open&&createPortal(<div onClick={event=>event.stopPropagation()}><FeeBookingNodeDialog key={`${scope}:${record.id}`} id={record.id} onClose={()=>setOpen(false)} onSaved={()=>{setOpen(false);onSaved?.();}}/></div>,document.body)}</>;
}
function FeeBookingNodeDialog({id,onClose,onSaved}:{id:number;onClose:()=>void;onSaved:()=>void}){
 const [record,setRecord]=useState<ResourceDto|null>(null),[nodes,setNodes]=useState<string[]>([]),[note,setNote]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
 const alive=useRef(false),writing=useRef(false),requestKey=useRef(crypto.randomUUID());
 useEffect(()=>{alive.current=true;setRecord(null);setError('');let current=true;
  resourceApi.get('finance-fee-items',id).then(row=>{if(current&&alive.current){if(!row.version)throw new Error('资料版本读取失败，请重试');setRecord(row);setNodes(nodesOf(row.data.defaultObject));setNote(String(row.data.relationRequirement??''));}}).catch(error=>{if(current&&alive.current)setError(error instanceof Error?error.message:'费用资料读取失败');});
  return()=>{current=false;alive.current=false;};
 },[id,retry]);
 async function save(){
  if(!record||writing.current)return;writing.current=true;setBusy(true);setError('');
  try{await resourceApi.saveForm('finance-fee-items',{id,version:record.version,requestKey:requestKey.current,values:{defaultObject:nodes.join('、'),relationRequirement:note},collections:[]});if(alive.current){clearRefCache('finance-fee-items');onSaved();}}
  catch(error){if(alive.current)setError(error instanceof Error?error.message:'保存失败，请重试');}
  finally{writing.current=false;if(alive.current)setBusy(false);}
 }
 const options=feeBookingOptions(nodes);
 return <FinanceModal title="选择挂账节点" subtitle={`${record?.data.name||record?.title||'费用类型'} 只修改费用单需要挂到哪个资料节点。`} className="fee-booking-node-modal" presentation="reference" busy={busy} onClose={onClose}>
  {!record&&!error&&<div role="status">正在读取费用资料…</div>}
  {error&&<div role="alert" className="notice error">{error}{!record&&<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button>}</div>}
  {record&&<><div className="fee-booking-node-options">{options.map(node=>{const fixed=node==='不固定',active=fixed?!nodes.length:nodes.includes(node);return <button key={node} type="button" className={active?'active':''} aria-pressed={active} disabled={busy} onClick={()=>{requestKey.current=crypto.randomUUID();setNodes(current=>fixed?[]:current.includes(node)?current.filter(value=>value!==node):[...current,node]);}}><strong>{node}</strong><span>{!fixed&&node!=='公司'?'费用单必须选择这个资料':node==='公司'?'公司公共费用默认使用':'按实际业务补充关联'}</span></button>;})}</div><label className="fee-booking-node-note"><span>挂账节点说明</span><textarea maxLength={500} placeholder="写清这个费用单必须挂什么资料，连带建议挂什么资料。" value={note} disabled={busy} onChange={event=>{requestKey.current=crypto.randomUUID();setNote(event.target.value);}}/></label></>}
  <footer className="fee-booking-node-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={busy||!record} onClick={()=>void save()}>保存挂账节点</button></footer>
 </FinanceModal>;
}
