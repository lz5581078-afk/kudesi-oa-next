import {useEffect,useRef,useState} from 'react';
import {useAuth} from '../../auth/AuthContext';
import {resourceApi} from '../../resources/api';
import {referencePickOption,type PickOption,type SearchPickProps} from './referencePickOptions';

/** 旧制单选择器在完整资料中按展示文字搜索，最多展示80项，不按服务端搜索字段截断资料。 */
export function ReferenceResourcePick(props:SearchPickProps){
  const {user}=useAuth();
  return <CompleteReferencePick key={JSON.stringify([props.type,props.fieldKey,props.fieldValue,props.referenceLabel,user?.companyId,user?.id,user?.permissions])} {...props}/>;
}
function CompleteReferencePick({type,value,label,onChange,placeholder,fieldKey,fieldValue,ariaLabel,options,excludeIds,referenceLabel}:SearchPickProps){
  const [all,setAll]=useState<PickOption[]|null>(null),[open,setOpen]=useState(false),[keyword,setKeyword]=useState(''),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const root=useRef<HTMLDivElement>(null),serial=useRef(0),mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;serial.current++;};},[]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
    document.addEventListener('mousedown',outside);return()=>document.removeEventListener('mousedown',outside);
  },[open]);
  const load=async()=>{
    const request=++serial.current,current=()=>mounted.current&&serial.current===request;
    setLoading(true);setError('');
    try{
      const collected:PickOption[]=[],seen=new Set<number>();let total:number|undefined;
      for(let page=1;;page++){
        if(!current())return;
        const response=await resourceApi.list(type,{page,pageSize:200,fieldKey,fieldValue});
        if(!current())return;
        if(!Number.isSafeInteger(response.total)||response.total<0)throw new Error('资料总数无效，请重试');
        if(total===undefined)total=response.total;else if(total!==response.total)throw new Error('读取期间资料发生变动，请重试');
        for(const item of response.items){
          if(seen.has(item.id))throw new Error('资料未能完整读取，请重试');
          seen.add(item.id);
          if(!['inactive','deleted','disabled'].includes(item.status))collected.push(referencePickOption(type,item,referenceLabel));
        }
        if(seen.size===total)break;
        if(!response.items.length||seen.size>total)throw new Error('资料未能完整读取，请重试');
      }
      if(current())setAll(collected);
    }catch{if(current()){setAll(null);setError('资料读取失败，请重试');}}
    finally{if(current())setLoading(false);}
  };
  const text=keyword.trim().toLocaleLowerCase();
  const items=(options??all??[]).filter(item=>!excludeIds?.includes(item.id)&&[item.title,item.detail].filter(Boolean).join(' · ').toLocaleLowerCase().includes(text)).slice(0,80);
  return <div className={`pick reference-document-picker${open?' open':''}`} ref={root} onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();setOpen(false);root.current?.querySelector<HTMLButtonElement>('.reference-document-picker-trigger')?.focus();}}}>
    <button type="button" data-grid-picker className="reference-document-picker-trigger" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} onClick={()=>{setOpen(!open);if(!open){setKeyword('');if(!options&&all===null&&!loading)void load();}}}><span className={!value?'placeholder':''}>{label||placeholder||'请选择资料'}</span><b aria-hidden="true">{open?'▲':'▼'}</b></button>
    {open&&<div className="reference-document-picker-menu" data-picker-menu><input autoFocus aria-label={`搜索${ariaLabel||'资料'}`} placeholder={`搜索${placeholder||ariaLabel||'资料'}`} value={keyword} onChange={event=>setKeyword(event.target.value)}/><ul role="listbox" className="pick-list">
      {!!value&&<li><button type="button" role="option" aria-selected={false} onClick={()=>{onChange(null,'');setKeyword('');setOpen(false);}}>清空当前选择</button></li>}
      {loading&&!options?<li role="status">正在加载资料…</li>:error&&!options?<li role="alert">{error}<button type="button" onClick={()=>void load()}>重试</button></li>:!items.length?<li className="muted">没有匹配资料</li>:items.map(item=><li key={item.id}><button type="button" role="option" aria-selected={item.id===value} onClick={()=>{onChange(item.id,item.title,item.data,item.optionLabels);setKeyword('');setOpen(false);}}>{item.title}{item.detail?` · ${item.detail}`:''}</button></li>)}
    </ul></div>}
  </div>;
}
