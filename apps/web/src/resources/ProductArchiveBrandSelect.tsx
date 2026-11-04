import {useEffect,useRef,useState} from 'react';
import {ChevronDown,Plus} from 'lucide-react';
import {pinyin} from 'pinyin-pro';
import {createChecker,resourcePermission} from '@kudesi/shared';
import {useAuth} from '../auth/AuthContext';
import {loadResourceDirectory} from './resourceDirectory';
import {clearRefCache,useRefVersion} from './ResourceReferenceControls';
import {resourceApi,type ResourceDto} from './api';
import './productArchiveBrandSelect.css';
type Props={inputId?:string;value:unknown;labelNow?:string;onChange:(value:number|null)=>void;onPendingChange?:(pending:boolean)=>void};
const nameKey=(value:string)=>value.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase();
/** 品牌仍保存真实资料ID，原输入记忆入口复用同一资料写入与权限。 */
export function ProductArchiveBrandSelect(props:Props){const{user}=useAuth();return <BrandSelect key={JSON.stringify([user?.id,user?.companyId,user?.permissions])} {...props}/>;}
function BrandSelect({inputId,value,labelNow,onChange,onPendingChange}:Props){
 const {user}=useAuth(),can=user?createChecker(user.permissions):()=>false,version=useRefVersion();
 const alive=useRef(true),working=useRef(false),timer=useRef<ReturnType<typeof setTimeout>>(),remembered=useRef(new Map<number,ResourceDto>());
 const [rows,setRows]=useState<ResourceDto[]|null>(null),[open,setOpen]=useState(false),[word,setWord]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0),[saving,setSaving]=useState(false);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;clearTimeout(timer.current);onPendingChange?.(false);};},[]); // parent is identity keyed
 useEffect(()=>{let current=true;setRows(null);setError('');void loadResourceDirectory('finance-brands',()=>current,undefined,{includeInactive:true,preserveOrder:true}).then(result=>{if(current&&result)setRows(result);}).catch(failure=>{if(current)setError(failure instanceof Error?failure.message:'品牌读取失败，请重试');});return()=>{current=false;};},[retry,version]);
 const catalog=[...(rows??[]),...Array.from(remembered.current.values()).filter(row=>!rows?.some(item=>item.id===row.id))],selected=catalog.find(row=>row.id===value),query=word.trim().toLocaleLowerCase();
 const shown=catalog.filter(row=>row.status==='active'&&[row.title,row.data.code,pinyin(row.title,{pattern:'first',toneType:'none',separator:''})].some(value=>String(value||'').toLocaleLowerCase().includes(query)));
 const exact=catalog.find(row=>row.status==='active'&&nameKey(row.title)===nameKey(word)),mayCreate=can(resourcePermission('finance-brands','create'));
 async function commit(raw:string){
  if(working.current)return;
  const name=raw.normalize('NFKC').trim().replace(/\s+/g,' ');
  if(!name){onChange(null);setWord('');setOpen(false);return;}
  if(rows===null){setError('品牌读取未完成，请稍后重试');setOpen(true);return;}
  const existing=catalog.find(row=>nameKey(row.title)===nameKey(name));
  if(existing?.status==='active'){onChange(existing.id);setWord(existing.title);setOpen(false);setError('');return;}
  working.current=true;setSaving(true);onPendingChange?.(true);setError('');onChange(null);
  try{
   if(name.length>160)throw new Error('品牌名称不能超过160个字符');
   let saved:ResourceDto;
   if(existing){if(!can(resourcePermission('finance-brands','disable')))throw new Error('该品牌已停用，需要恢复品牌的权限');saved=await resourceApi.changeStatus('finance-brands',existing.id,'active');}
   else{if(!mayCreate)throw new Error('请从已有品牌中选择');saved=await resourceApi.create('finance-brands',{name});}
   if(!alive.current)return;
   remembered.current.set(saved.id,saved);setRows(current=>[...(current??[]).filter(row=>row.id!==saved.id),saved]);onChange(saved.id);setWord(saved.title);setOpen(false);clearRefCache('finance-brands');
  }catch(failure){if(alive.current){setError(failure instanceof Error?failure.message:'品牌保存失败');setWord(name);setOpen(true);}}
  finally{working.current=false;if(alive.current){setSaving(false);onPendingChange?.(false);}}
 }
 return <div className="product-archive-brand-select" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget)){clearTimeout(timer.current);timer.current=setTimeout(()=>{if(alive.current)void commit(word);},140);}}}><div><input id={inputId} role="combobox" aria-label={inputId?undefined:'品牌'} aria-expanded={open} autoComplete="off" disabled={saving} value={open?word:selected?.title||word||labelNow||(value?`#${value}`:'')} placeholder="请输入或选择品牌" onFocus={()=>{clearTimeout(timer.current);setOpen(true);setWord(selected?.title||word||labelNow||'');}} onChange={event=>{setOpen(true);setWord(event.target.value);setError('');const match=catalog.find(row=>row.status==='active'&&nameKey(row.title)===nameKey(event.target.value));onChange(match?.id??null);}} onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);}if(event.key==='Enter'){event.preventDefault();void commit(word);}}}/><button type="button" disabled={saving} aria-label="展开品牌选项" onMouseDown={event=>event.preventDefault()} onClick={()=>{setOpen(!open);setWord('');}}><ChevronDown size={16}/></button></div>{open&&<div role="listbox" aria-label="品牌选项">{rows===null?<p>{error||'正在读取…'}{error&&<button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button>}</p>:<>{query&&!exact&&mayCreate&&<button type="button" className="product-brand-create" disabled={saving} onMouseDown={event=>event.preventDefault()} onClick={()=>void commit(word)}><Plus size={16}/>使用并保存“{word.trim()}”</button>}{shown.map(row=><button type="button" role="option" aria-selected={row.id===value} key={row.id} onMouseDown={event=>event.preventDefault()} onClick={()=>void commit(row.title)}><strong>{row.title}</strong><small>{String(row.data.code||pinyin(row.title,{pattern:'first',toneType:'none',separator:''}))}</small></button>)}{!shown.length&&!query&&<p>暂无品牌，可直接输入新品牌</p>}{!shown.length&&query&&!mayCreate&&<p>没有符合条件的选项</p>}</>}</div>}{error&&rows!==null&&<small role="alert" className="product-brand-error">{error}</small>}</div>;
}
