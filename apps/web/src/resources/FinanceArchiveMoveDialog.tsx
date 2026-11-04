import {useEffect,useState} from 'react';
import {createPortal} from 'react-dom';
import {useAuth} from '../auth/AuthContext';
import {referenceIdentity} from './referenceOptionsCache';
import {ApiError} from '../api/client';
import {loadRefOptions} from './RecordForm';
/** 只收集24号原版移动字段；保存继续走统一批量资源接口。 */
export function FinanceArchiveMoveDialog({type,count,initialCategoryId,onClose,onConfirm}:{type:string;count:number;initialCategoryId?:number;onClose:()=>void;onConfirm:(id:number)=>Promise<void>}){
 const {user}=useAuth();const scope=referenceIdentity(user);
 const noun=type==='finance-suppliers'?'供应商':type==='finance-fee-items'?'费用':'客户';
 const [options,setOptions]=useState<Array<{value:number|string;label:string}>>([]),[value,setValue]=useState(initialCategoryId ? String(initialCategoryId) : ''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{let alive=true;loadRefOptions(type==='finance-suppliers'?'finance-supplier-categories':type==='finance-fee-items'?'finance-fee-categories':'finance-customer-categories',scope).then(rows=>{if(alive)setOptions(rows);}).catch(()=>{if(alive)setError('目录加载失败，请关闭后重试');});return()=>{alive=false;};},[type,scope]);
 return createPortal(<div className="reference-contact-move-backdrop"><form className="reference-contact-move" role="dialog" aria-label={`移动${noun}分类`} onSubmit={async event=>{event.preventDefault();if(!value)return setError('请选择目标目录');if(busy)return;setBusy(true);try{await onConfirm(Number(value));}catch(e){setError(e instanceof ApiError?e.message:'移动失败');setBusy(false);}}}>
 <header><div><h2>移动{noun}分类</h2><p>已选择 {count} 条{noun}档案，移动后只显示在新的直属分类下。</p></div><button type="button" disabled={busy} onClick={onClose}>关闭</button></header>
 <label>目标目录<select value={value} disabled={busy} onChange={e=>{setValue(e.target.value);setError('');}}><option value="">请选择目标目录</option>{options.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
 <div className="reference-contact-move-summary"><strong>移动说明</strong><span>只移动资料的分类归属，不修改资料内容和历史操作记录。</span></div>
 {error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy}>{busy?'移动中…':'确认移动'}</button></footer>
 </form></div>,document.body);
}
