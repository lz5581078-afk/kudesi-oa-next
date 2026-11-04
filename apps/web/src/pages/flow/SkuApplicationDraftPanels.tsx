import {useEffect,useRef,useState} from 'react';
import type {SkuSpec} from '@kudesi/shared';
import {ApiError} from '../../api/client';
import {SkuApplyFields,SkuSharedFields} from './SkuApply';
import {flowApi,type ApplicationHeader,type RunDetailDto} from './flowApi';

export function SkuDraftSharedSettings({header,expected,editable,onSaved}:{header:ApplicationHeader;expected:Array<{id:number;revision:number}>;editable:boolean;onSaved:()=>void}){
 const [values,setValues]=useState<Record<string,unknown>>(header.shared),[busy,setBusy]=useState(false),[error,setError]=useState(''),[changed,setChanged]=useState(false);
 const baseline=useRef(JSON.stringify(header.shared)),version=useRef(header.headerVersion),dirty=JSON.stringify(values)!==baseline.current;
 useEffect(()=>{if(header.headerVersion===version.current)return;if(JSON.stringify(values)!==baseline.current){setChanged(true);return;}baseline.current=JSON.stringify(header.shared);version.current=header.headerVersion;setValues(header.shared);setChanged(false);},[header.headerVersion,header.shared,values]);
 function reload(){baseline.current=JSON.stringify(header.shared);version.current=header.headerVersion;setValues(header.shared);setChanged(false);setError('');}
 async function save(){setBusy(true);setError('');try{const out=await flowApi.saveApplicationDraftShared('sku-batch-apply',header.batchKey,{headerVersion:version.current,expected,payload:values});version.current=out.headerVersion;baseline.current=JSON.stringify(values);setChanged(false);onSaved();}catch(err){setError(err instanceof ApiError?err.message:'公共设置保存失败');}finally{setBusy(false);}}
 return <section className="sku-application-shared"><header><div><h3>本申请统一设置</h3><small>组合分类、销售场景、平台和默认品牌适用于本申请下的规格</small></div>{editable?<button type="button" className="primary-button" disabled={busy||!dirty} onClick={()=>void save()}>保存公共设置</button>:<span>规格进入后续环节后锁定</span>}</header>{changed&&<p role="status">公共资料或规格已变化，当前填写仍保留。<button type="button" onClick={reload}>重新加载公共设置</button></p>}{error&&<p role="alert">{error}</p>}<SkuSharedFields values={values} onChange={(key,value)=>setValues(current=>({...current,[key]:value}))} includeTitle={false} readOnly={!editable||busy}/></section>;
}

export function SkuDraftEditor({id,onClose,onSaved,onPrevious,onNext,onLeaveReady}:{id:number;onClose:()=>void;onSaved:(check:boolean)=>void;onPrevious?:()=>void;onNext?:()=>void;onLeaveReady?:(guard:((next:()=>void)=>void)|null)=>void}){
 const [detail,setDetail]=useState<RunDetailDto|null>(null),[values,setValues]=useState<Record<string,unknown>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');const baseline=useRef(''),host=useRef<HTMLElement>(null);
 useEffect(()=>{let alive=true;flowApi.run(id).then(out=>{if(alive){setDetail(out);setValues(out.payload);baseline.current=JSON.stringify(out.payload);host.current?.scrollIntoView?.({block:'nearest'});}}).catch(err=>{if(alive)setError(err instanceof ApiError?err.message:'规格读取失败');});return()=>{alive=false;};},[id]);
 const dirty=JSON.stringify(values)!==baseline.current;
 function leave(next:()=>void){if(busy)return;if(dirty&&!window.confirm('放弃当前规格尚未保存的修改？'))return;next();}
 useEffect(()=>{onLeaveReady?.(leave);return()=>onLeaveReady?.(null);},[busy,dirty,onLeaveReady]);
 async function save(check:boolean){if(!detail||busy)return;setBusy(true);setError('');try{await flowApi.saveApplicationDraft(id,{revision:detail.revision,payload:{specs:values.specs}});baseline.current=JSON.stringify(values);onSaved(check);}catch(err){setError(err instanceof ApiError?err.message:'规格保存失败');setBusy(false);}}
 const name=(values.specs as SkuSpec[]|undefined)?.[0]?.name;
 return <section ref={host} className="sku-draft-inline-editor" aria-label="规格资料配置" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();leave(onClose);}}}>
  <header><h3>规格资料配置</h3><div>{onPrevious&&<button type="button" disabled={busy} onClick={()=>leave(onPrevious)}>上一规格</button>}{onNext&&<button type="button" disabled={busy} onClick={()=>leave(onNext)}>下一规格</button>}</div></header>
  {error&&<div role="alert" className="notice error">{error}</div>}{!detail&&!error?<p>正在读取规格资料…</p>:detail&&<fieldset disabled={busy}><SkuApplyFields values={values} onChange={(key,value)=>setValues(current=>({...current,[key]:value}))} hideShared singleSpec/></fieldset>}
  <footer><span>{dirty?'有未保存修改':'资料已保存'}</span><div><button type="button" disabled={busy} onClick={()=>leave(onClose)}>关闭</button><button type="button" disabled={busy||!detail||!name?.trim()} onClick={()=>void save(false)}>保存明细</button><button type="button" className="primary-button" disabled={busy||!detail||!name?.trim()} onClick={()=>void save(true)}>保存并校验</button></div></footer>
 </section>;
}

export function SkuDraftAddDialog({header,onClose,onAdded}:{header:ApplicationHeader;onClose:()=>void;onAdded:()=>void}){
 const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),key=useRef(crypto.randomUUID());
 async function add(){if(!name.trim()||busy)return;setBusy(true);setError('');try{await flowApi.addApplicationDrafts('sku-batch-apply',header.batchKey,{headerVersion:header.headerVersion,requestKey:key.current,payloads:[{specs:[{name:name.trim(),main:[],gift:[]}]}]});onAdded();}catch(err){setError(err instanceof ApiError?err.message:'添加规格失败');setBusy(false);}}
 return <div className="modal-backdrop" role="presentation"><form className="modal card sku-draft-create sku-draft-add" role="dialog" aria-label="添加规格" onSubmit={event=>{event.preventDefault();void add();}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!busy)onClose();}}}><header><h2>添加规格</h2><button type="button" disabled={busy} onClick={onClose}>关闭</button></header><div className="sku-draft-create-body"><label>内部规格名称<input autoFocus value={name} maxLength={100} onChange={event=>setName(event.target.value)}/></label>{error&&<p role="alert">{error}</p>}</div><footer><span/><div><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button" disabled={busy||!name.trim()}>添加规格</button></div></footer></form></div>;
}
