import { useEffect, useRef, useState, type FormEvent } from 'react';
import { OPENING_PREPAYMENT_VOUCHERS } from '@kudesi/shared';
import { Trash2 } from 'lucide-react';
import { ApiError } from '../../api/client';
import type { FileInfo } from '../../resources/api';
import { financeApi, type DocDetailDto } from './financeApi';
import { money } from './common';

export const canRegisterOpeningPrepayment=(doc:DocDetailDto,allowed:boolean)=>allowed&&doc.status==='issued'&&doc.docType==='prepayment'&&doc.partyKind==='supplier'&&doc.sourceKey==null&&!doc.reversesId&&doc.amountCents>0;

/** 已在系统外付出的款项只补登记往来余额，不再扣银行。 */
export function OpeningPrepaymentDialog({ doc, inline = false, onBusyChange, onClose, onSaved }: { doc: DocDetailDto; inline?: boolean; onBusyChange?: (busy:boolean)=>void; onClose: () => void; onSaved: (d: DocDetailDto) => void }) {
  const [reason, setReason] = useState(''), [files, setFiles] = useState<FileInfo[]>([]), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const mounted=useRef(false),working=useRef(false),previews=useRef(new Map<number,string>());
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;for(const url of previews.current.values())URL.revokeObjectURL(url);previews.current.clear();};},[]);
  const begin=()=>{if(working.current||!mounted.current)return false;working.current=true;setBusy(true);setError('');onBusyChange?.(true);return true;};
  const end=()=>{if(!working.current)return;working.current=false;if(mounted.current){setBusy(false);onBusyChange?.(false);}};
  const fail = (e: unknown) => {if(mounted.current)setError(e instanceof ApiError || e instanceof Error ? e.message : '操作失败');};
  async function upload(list: File[]) {
    if(files.length+list.length>OPENING_PREPAYMENT_VOUCHERS.maxFiles)return fail(new Error('最多12份凭证'));
    if(list.some(file=>file.size<=0||file.size>OPENING_PREPAYMENT_VOUCHERS.maxBytes||!OPENING_PREPAYMENT_VOUCHERS.mimeTypes.some(mime=>mime===file.type)))return fail(new Error('支持PNG、JPG、WebP、PDF，单文件不超过2MB'));
    if(!begin())return;
    try {
      for (const file of list) {
        if(!mounted.current)return;
        const info = await financeApi.uploadOpeningVoucher(doc.id, file);
        if(!mounted.current)return;
        if(inline&&typeof URL.createObjectURL==='function')previews.current.set(info.id,URL.createObjectURL(file));
        setFiles(current => [...current, info]);
      }
    } catch (e) { fail(e); } finally { end(); }
  }
  const submit=async(event:FormEvent)=>{
    event.preventDefault();
    if(!reason.trim()||!files.length||!(inline||confirmed)||!begin())return;
    try {
      const saved=await financeApi.registerOpeningPrepayment(doc.id,{reason:reason.trim(),fileIds:files.map(file=>file.id),confirmed:inline||confirmed});
      end();if(mounted.current)onSaved(saved);
    }catch(error){fail(error);}finally{end();}
  };
  const fileInput=<input type="file" multiple accept={OPENING_PREPAYMENT_VOUCHERS.mimeTypes.join(',')} disabled={busy} onChange={event=>{const selected=Array.from(event.target.files??[]);event.target.value='';if(selected.length)void upload(selected);}}/>;
  const remove=(id:number)=>{const url=previews.current.get(id);if(url){URL.revokeObjectURL(url);previews.current.delete(id);}setFiles(current=>current.filter(file=>file.id!==id));};
  const fileList=<ul className={inline?'reference-opening-file-list':'stack'}>{files.map(file=><li key={file.id} className={inline?undefined:'between'}>{inline&&previews.current.has(file.id)?<a href={previews.current.get(file.id)} target="_blank" rel="noreferrer">{file.name}</a>:<span>{file.name}</span>}<button type="button" className={inline?'reference-opening-remove':'link-button'} disabled={busy} aria-label={inline?`删除${file.name}`:`移除 ${file.name}`} onClick={()=>remove(file.id)}>{inline?<Trash2 size={14}/>:'移除'}</button></li>)}</ul>;
  if(inline)return <form className="reference-document-opening" role="group" aria-label="登记已有预付款余额" onSubmit={submit}>
    <label>核对说明<input aria-label="预付款期初核对说明" value={reason} maxLength={500} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>
    <div className="reference-opening-attachments"><label>已有预付款凭证{fileInput}</label>{fileList}</div>
    {error&&<div role="alert" className="notice error">{error}</div>}
    <button type="submit" className="primary-button" disabled={busy||!reason.trim()||!files.length}>{busy?'处理中…':'确认预付款余额并入账'}</button>
  </form>;
  return <div className="modal-backdrop" role="presentation"><form className="modal card small" role="dialog" aria-label="登记已有预付款余额" onSubmit={submit}>
    <div className="modal-head between"><strong>登记已有预付款余额</strong><button type="button" className="icon-button" aria-label="关闭登记" disabled={busy} onClick={onClose}>×</button></div>
    <div className="modal-body">
      <p>{doc.docNo} · {doc.partyName} · {money(doc.amountCents)}</p><p className="notice">用于登记上线前已经付给供应商的款项。登记后增加供应商预付余额，不扣银行或现金余额。</p>
      <label>核对说明（必填）<textarea required maxLength={500} rows={3} disabled={busy} value={reason} onChange={event=>setReason(event.target.value)}/></label>
      <label>凭证附件（至少 1 个，最多 12 个，每个不超过 2MB）{fileInput}</label>{fileList}
      <label><input type="checkbox" disabled={busy} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已核对：款项已在系统上线前付出，本次仅登记预付余额，不再扣银行余额。</label>
      {error&&<div role="alert" className="notice error">{error}</div>}
    </div>
    <div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy||!reason.trim()||!files.length||!confirmed}>{busy?'处理中…':'确认登记'}</button></div>
  </form></div>;
}
