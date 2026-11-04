import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {createPortal} from 'react-dom';
import './productArchiveActionDialog.css';

export interface ProductArchiveActionDialogProps{
 mode:'off'|'on'|'del';
 /** The real record name, or the summary supplied by the selected-record caller. */
 title:string;
 selectedCount?:number;
 recordLabel?:string;
 onConfirm:(reason?:string)=>Promise<unknown>;
 onClose:()=>void;
}
/** Presentation only. The caller retains canonical permissions, revision and reference checks. */
export function ProductArchiveActionDialog({mode,title,selectedCount=1,recordLabel='商品',onConfirm,onClose}:ProductArchiveActionDialogProps){
 const [reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),working=useRef(false),mounted=useRef(false),close=useRef(onClose),form=useRef<HTMLFormElement>(null),heading=useId();close.current=onClose;
 useEffect(()=>{mounted.current=true;const previous=document.activeElement as HTMLElement|null;form.current?.querySelector<HTMLButtonElement>('[aria-label="关闭"]')?.focus();return()=>{mounted.current=false;if(previous?.isConnected)previous.focus();};},[]);
 const action=mode==='off'?'停用':mode==='on'?'启用':'彻底删除';
 async function submit(event:FormEvent){event.preventDefault();if(working.current)return;const value=reason.trim();if(mode==='off'&&!value){setError('请填写停用原因。');return;}working.current=true;setBusy(true);setError('');try{await onConfirm(mode==='off'?value:undefined);if(mounted.current)close.current();}catch(error){if(mounted.current){setError(error instanceof Error?error.message:'操作失败，请重试');working.current=false;setBusy(false);}}}
 return createPortal(<div className="product-archive-action-backdrop"><form ref={form} className={`product-archive-action-dialog${mode==='del'?' product-archive-delete-dialog':' product-archive-status-dialog'}`} role="dialog" aria-modal="true" aria-labelledby={heading} onSubmit={submit}>
  <header><div><h2 id={heading}>{mode==='del'?'确认彻底删除商品':`确认${action}${recordLabel}`}</h2><p>{mode==='del'?'仅未被业务单据使用的商品可以彻底删除，删除后无法恢复。':mode==='off'?'停用后默认列表将不再显示，历史业务数据不受影响。':'启用后将恢复为正常状态，并重新出现在默认列表中。'}</p></div><button type="button" className="product-archive-action-close" aria-label="关闭" disabled={busy} onClick={onClose}>关闭</button></header>
  <div className="product-archive-action-summary"><strong>{mode==='del'||selectedCount===1?title:`将${action} ${selectedCount} 条${recordLabel}`}</strong><span>{mode==='del'?'若商品已被基础编码、BOM、包装方案或成本快照使用，系统将阻止删除，请改为停用。':'本次操作会记录到对应档案的操作日志中。'}</span></div>
  {mode==='off'&&<label className="product-archive-action-reason"><span>停用原因 <em>必填</em></span><textarea aria-label="停用原因" placeholder="请输入本次停用原因" value={reason} disabled={busy} onChange={event=>{setReason(event.target.value);setError('');}}/>{error&&<small role="alert">{error}</small>}</label>}
  {error&&mode!=='off'&&<p className="product-archive-action-error" role="alert">{error}</p>}
  <footer><button type="button" className="product-archive-action-cancel" disabled={busy} onClick={onClose}>取消</button><button type="submit" className={`product-archive-action-confirm action-${mode}`} disabled={busy}>{busy&&mode==='del'?'正在删除…':`确认${action}`}</button></footer>
 </form></div>,document.body);
}
