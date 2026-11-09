import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowRight,FileCheck2,X} from 'lucide-react';
import type {SkuSpec} from '@kudesi/shared';
import {ReasonDialog} from '../../resources/ResourceConfirmDialog';
import {ApiError} from '../../api/client';
import {SkuApplyFields,SkuSharedFields,skuBatchApi,type BatchBoard} from './SkuApply';
import {flowApi,type ApplicationHeader,type RunDetailDto} from './flowApi';

export function SkuDraftSharedSettings({header,expected,editable,onSaved,sourceLayout=false,runId}:{runId?:number;sourceLayout?:boolean;header:ApplicationHeader;expected:Array<{id:number;revision:number}>;editable:boolean;onSaved:()=>void}){
 const [values,setValues]=useState<Record<string,unknown>>(header.shared),[busy,setBusy]=useState(false),[error,setError]=useState(''),[changed,setChanged]=useState(false);
 const baseline=useRef(JSON.stringify(header.shared)),version=useRef(header.headerVersion),dirty=JSON.stringify(values)!==baseline.current;
 useEffect(()=>{if(header.headerVersion===version.current)return;if(JSON.stringify(values)!==baseline.current){setChanged(true);return;}baseline.current=JSON.stringify(header.shared);version.current=header.headerVersion;setValues(header.shared);setChanged(false);},[header.headerVersion,header.shared,values]);
 function reload(){baseline.current=JSON.stringify(header.shared);version.current=header.headerVersion;setValues(header.shared);setChanged(false);setError('');}
 async function save(){setBusy(true);setError('');try{const out=await flowApi.saveApplicationDraftShared('sku-batch-apply',header.batchKey,{headerVersion:version.current,expected,payload:values});version.current=out.headerVersion;baseline.current=JSON.stringify(values);setChanged(false);onSaved();}catch(err){setError(err instanceof ApiError?err.message:'公共设置保存失败');}finally{setBusy(false);}}
 return <section className={`sku-application-shared${sourceLayout?' sku-reference-settings':''}`}><header><div><h3>本申请统一设置</h3><small>组合分类、销售场景、平台和默认品牌适用于本申请下的规格</small></div>{editable?<button type="button" className="primary-button" disabled={busy||!dirty} onClick={()=>void save()}>保存公共设置</button>:<span>规格进入后续环节后锁定</span>}</header>{changed&&<p role="status">公共资料或规格已变化，当前填写仍保留。<button type="button" onClick={reload}>重新加载公共设置</button></p>}{error&&<p role="alert">{error}</p>}<SkuSharedFields values={values} onChange={(key,value)=>setValues(current=>({...current,[key]:value}))} includeTitle={false} readOnly={!editable||busy} sourceLayout={sourceLayout} runId={runId}/></section>;
}

export function SkuDraftEditor({id,onClose,onSaved,onPrevious,onNext,onLeaveReady,position=0,total=1,sourceLayout=false,applicationHeader}:{applicationHeader?:ApplicationHeader;position?:number;total?:number;sourceLayout?:boolean;id:number;onClose:()=>void;onSaved:(check:boolean)=>void;onPrevious?:()=>void;onNext?:()=>void;onLeaveReady?:(guard:((next:()=>void)=>void)|null)=>void}){
 const [detail,setDetail]=useState<RunDetailDto|null>(null),[values,setValues]=useState<Record<string,unknown>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');const baseline=useRef(''),host=useRef<HTMLElement>(null);
 const [refreshing, setRefreshing] = useState(true);
 const savedPayload = useRef<Record<string, unknown> | null>(null);
 const currentValues = useRef(values);
 currentValues.current = values;
 useEffect(() => {
   let alive = true;
   setRefreshing(true);
   flowApi.run(id).then(out => {
     if (!alive) return;
     const previous = savedPayload.current;
     const dirty = !!previous && JSON.stringify(currentValues.current) !== baseline.current;
     if (dirty && JSON.stringify(previous.specs) !== JSON.stringify(out.payload.specs)) {
       setError('该规格已被修改，当前填写仍保留。请关闭并重新打开规格后再编辑。');
       return;
     }
     setDetail(out);
     savedPayload.current = out.payload;
     baseline.current = JSON.stringify(out.payload);
     setValues(dirty ? { ...out.payload, specs: currentValues.current.specs } : out.payload);
     if (!previous) host.current?.scrollIntoView?.({block:'nearest'});
   }).catch(err => { if (alive) setError(err instanceof ApiError ? err.message : '规格读取失败'); })
     .finally(() => { if (alive) setRefreshing(false); });
   return () => { alive = false; };
 }, [id, applicationHeader?.headerVersion]);
 const dirty=JSON.stringify(values)!==baseline.current;
 function leave(next:()=>void){if(busy)return;if(dirty&&!window.confirm('放弃当前规格尚未保存的修改？'))return;next();}
 useEffect(()=>{onLeaveReady?.(leave);return()=>onLeaveReady?.(null);},[busy,dirty,onLeaveReady]);
 async function save(check:boolean){if(!detail||busy||refreshing)return;setBusy(true);setError('');try{await flowApi.saveApplicationDraft(id,{revision:detail.revision,payload:{specs:values.specs}});baseline.current=JSON.stringify(values);onSaved(check);}catch(err){setError(err instanceof ApiError?err.message:'规格保存失败');setBusy(false);}}
 const name=(values.specs as SkuSpec[]|undefined)?.[0]?.name;
 return <>{sourceLayout&&<div className="sku-reference-inline-nav"><span>运营配置 · 第 {position+1} / {total} 个待处理规格</span><div><button type="button" disabled={busy||!onPrevious} onClick={()=>onPrevious&&leave(onPrevious)}><ArrowLeft size={15}/>上一规格</button><button type="button" disabled={busy||!onNext} onClick={()=>onNext&&leave(onNext)}><ArrowRight size={15}/>下一规格</button></div></div>}<section ref={host} className={`sku-draft-inline-editor${sourceLayout?' sku-reference-inline-editor':''}`} aria-label="规格资料配置" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();leave(onClose);}}}>
  <header>{sourceLayout?<><div className="sku-reference-inline-title"><small>当前规格 · 资料编辑</small><h3>规格资料配置</h3></div><button type="button" title="收起编辑" aria-label="收起编辑" disabled={busy} onClick={()=>leave(onClose)}><X size={16}/></button></>:<><h3>规格资料配置</h3><div>{onPrevious&&<button type="button" disabled={busy} onClick={()=>leave(onPrevious)}>上一规格</button>}{onNext&&<button type="button" disabled={busy} onClick={()=>leave(onNext)}>下一规格</button>}</div></>}</header>
  {error&&<div role="alert" className="notice error">{error}</div>}{!detail&&!error?<p>正在读取规格资料…</p>:detail&&<fieldset disabled={busy}><SkuApplyFields values={applicationHeader ? {...values, brandId:applicationHeader.shared.brandId} : values} onChange={(key,value)=>setValues(current=>({...current,[key]:value}))} hideShared singleSpec sourceLayout={sourceLayout} runId={id} sourceStageName={detail.activeStep?.name} sourceHandlerName={detail.activeStep?.recipients.map(person=>person.name).join('、')}/></fieldset>}
  <footer><span>{dirty?'有未保存修改':'资料已保存'}</span><div><button type="button" disabled={busy} onClick={()=>leave(onClose)}>关闭</button><button type="button" disabled={busy||refreshing||!detail||!name?.trim()} onClick={()=>void save(false)}>保存明细</button><button type="button" className="primary-button" disabled={busy||refreshing||!detail||!name?.trim()} onClick={()=>void save(true)}>{sourceLayout&&<FileCheck2 size={16}/>}保存并校验</button></div></footer>
 </section></>;
}


export function SkuApplicationDeleteDialog({batchKey,title,onClose,onDeleted}:{batchKey:string;title:string;onClose:()=>void;onDeleted:()=>void}){
 const [board,setBoard]=useState<BatchBoard|null>(null),[error,setError]=useState('');
 useEffect(()=>{let alive=true;skuBatchApi.board(batchKey).then(value=>{if(alive)setBoard(value);}).catch(error=>{if(alive)setError(error instanceof ApiError?error.message:'申请读取失败');});return()=>{alive=false;};},[batchKey]);
 if(!board)return <div className="modal-backdrop"><section role="dialog" aria-label="删除SKU申请" className="modal card small"><h2>删除SKU申请</h2><p>{error||'正在读取申请资料…'}</p><button type="button" onClick={onClose}>关闭</button></section></div>;
 return <ReasonDialog title="删除SKU申请" hint={`确定删除申请「${title}」及其 ${board.total} 个规格吗？草稿或仓库退回的资料、相关待办将一并删除，且无法恢复。`} requireReason={false} confirmLabel="确认删除" danger onClose={onClose} onConfirm={async()=>{const header=board.applicationHeader;if(!header?.canDelete)throw new ApiError(409,'申请状态已变化，请刷新后重试');await flowApi.removeApplicationDraftBatch('sku-batch-apply',batchKey,{headerVersion:header.headerVersion,expected:[...new Map(board.items.map(item=>[item.runId,{id:item.runId,revision:item.revision}])).values()],reason:'申请人删除SKU申请'});onDeleted();}}/>;
}
