import {useEffect,useId,useRef,useState} from 'react';
import {ChevronDown,Pencil,Plus,Save,Settings2,Trash2,X} from 'lucide-react';
import {createChecker,resourcePermission} from '@kudesi/shared';
import {useAuth} from '../auth/AuthContext';
import {resourceApi,type ResourceDto} from './api';
import {loadResourceDirectory} from './resourceDirectory';
import './productQualityReasons.css';

const type='finance-zero-reasons';
export function useProductQualityReasons(){
 const {user}=useAuth(),allowed=user?createChecker(user.permissions):()=>false;
 const can=(action:'view'|'create'|'edit'|'delete')=>allowed(resourcePermission(type,action));
 const [rows,setRows]=useState<ResourceDto[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const alive=useRef(true),epoch=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;};},[]);
 async function load(){
  const serial=++epoch.current,current=()=>alive.current&&serial===epoch.current;
  if(!can('view')){setRows([]);return;}
  setBusy(true);setError('');
  try{const result=await loadResourceDirectory(type,current,undefined,{preserveOrder:true});if(current()&&result)setRows(result);}
  catch(failure){if(current())setError(failure instanceof Error?failure.message:'原因加载失败');}
  finally{if(current())setBusy(false);}
 }
 useEffect(()=>{void load();},[]); // keyed by the dialog's real user/company/permissions
 async function change(action:'create'|'edit'|'delete',reason:string,row?:ResourceDto){
  if(busy||!can(action))return false;
  const serial=++epoch.current,current=()=>alive.current&&serial===epoch.current;
  setBusy(true);setError('');
  try{
   if(action==='delete')await resourceApi.remove(type,row!.id,'删除常用零值原因');
   else if(action==='edit')await resourceApi.update(type,row!.id,{reason});
   else await resourceApi.create(type,{reason});
   if(!current())return false;
   if(!can('view'))return true;
   const result=await loadResourceDirectory(type,current,undefined,{preserveOrder:true});
   if(!current()||!result)return false;setRows(result);return true;
  }catch(failure){if(current())setError(failure instanceof Error?failure.message:'原因保存失败');return false;}
  finally{if(current())setBusy(false);}
 }
 return {rows,busy,error,can,change,reload:load};
}
type Catalog=ReturnType<typeof useProductQualityReasons>;
export function ProductZeroReasonInput({value,onChange,rows,label,disabled}:{value:string;onChange:(value:string)=>void;rows:ResourceDto[];label:string;disabled:boolean}){
 const [open,setOpen]=useState(false),[all,setAll]=useState(false),[focusFirst,setFocusFirst]=useState(false);
 const id=useId(),input=useRef<HTMLInputElement>(null),list=useRef<HTMLDivElement>(null);
 const matches=rows.filter(row=>all||row.title.toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()));
 useEffect(()=>{if(open&&focusFirst){list.current?.querySelector('button')?.focus();setFocusFirst(false);}},[open,focusFirst]);
 return <div className="product-zero-combo" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setOpen(false);}}><div className="product-zero-input"><input ref={input} role="combobox" aria-label={label} aria-expanded={open} aria-controls={id} aria-autocomplete="list" maxLength={180} disabled={disabled} value={value} placeholder="选择或输入原因" onFocus={()=>setOpen(true)} onChange={event=>{onChange(event.target.value);setAll(false);setOpen(true);}} onKeyDown={event=>{if(event.key==='Escape'&&open){event.stopPropagation();setOpen(false);}if(event.key==='ArrowDown'){event.preventDefault();setOpen(true);setFocusFirst(true);}}}/><button type="button" title="展开常用原因" aria-label={`${label}下拉选项`} disabled={disabled} onClick={()=>{setAll(true);setOpen(!open);}}><ChevronDown size={16}/></button></div>{open&&!disabled&&<div ref={list} className="product-zero-options" role="listbox" id={id} aria-label="常用零值原因" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();input.current?.focus();setOpen(false);}if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const buttons=Array.from(event.currentTarget.querySelectorAll('button')),index=buttons.indexOf(document.activeElement as HTMLButtonElement);buttons[(index+(event.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}}}>{matches.map(row=><button key={row.id} type="button" role="option" aria-selected={value===row.title} onClick={()=>{onChange(row.title);setOpen(false);}}>{row.title}</button>)}{!matches.length&&<span>暂无匹配原因</span>}</div>}</div>;
}
export function ProductZeroReasonManager({catalog,disabled=false}:{catalog:Catalog;disabled?:boolean}){
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),[editing,setEditing]=useState<ResourceDto|null>(null),[search,setSearch]=useState('');
 const editAllowed=!disabled&&(editing?catalog.can('edit'):catalog.can('create'));
 async function save(){if(await catalog.change(editing?'edit':'create',draft.trim(),editing??undefined)){setDraft('');setEditing(null);}}
 return <div className="product-zero-manager"><button type="button" className="secondary-button" disabled={disabled} onClick={()=>setOpen(!open)}><Settings2 size={15}/>管理零值原因</button>{open&&<div className="product-zero-maintenance"><div className="product-zero-tools"><input aria-label="维护原因搜索" placeholder="搜索原因" disabled={disabled} value={search} onChange={event=>setSearch(event.target.value)}/></div>{(catalog.can('create')||editing)&&<div className="product-zero-tools"><input aria-label="常用原因名称" placeholder="输入常用原因" maxLength={180} value={draft} disabled={catalog.busy||!editAllowed} onChange={event=>setDraft(event.target.value)}/><button type="button" title={editing?'保存修改':'新增原因'} aria-label={editing?'保存原因修改':'新增原因'} disabled={!draft.trim()||catalog.busy||!editAllowed} onClick={()=>void save()}>{editing?<Save size={17}/>:<Plus size={17}/>}</button>{editing&&<button type="button" aria-label="取消原因编辑" onClick={()=>{setEditing(null);setDraft('');}}><X size={17}/></button>}</div>}<div className="product-zero-maintenance-list">{catalog.rows.filter(row=>row.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).map(row=><div key={row.id}><span>{row.title}</span>{catalog.can('edit')&&<button type="button" aria-label={`编辑原因${row.title}`} disabled={catalog.busy||disabled} onClick={()=>{setEditing(row);setDraft(row.title);}}><Pencil size={15}/></button>}{catalog.can('delete')&&<button type="button" aria-label={`删除原因${row.title}`} disabled={catalog.busy||disabled} onClick={()=>void catalog.change('delete','',row).then(saved=>{if(saved&&editing?.id===row.id){setEditing(null);setDraft('');}})}><Trash2 size={15}/></button>}</div>)}</div></div>}{catalog.error&&<p role="alert">{catalog.error}<button type="button" className="link-button" onClick={()=>void catalog.reload()}>重试</button></p>}</div>;
}
