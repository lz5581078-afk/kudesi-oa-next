import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';

export function AfterSalesProductImage({src,detail=false}:{src:string;detail?:boolean}){
 const [open,setOpen]=useState(false),[failed,setFailed]=useState(false),[loaded,setLoaded]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  const element=dialog.current;
  if(!open||!element)return;
  if(typeof element.showModal==='function')element.showModal();
  else element.setAttribute('open','');
  return()=>{if(typeof element.close==='function'&&element.open)element.close();trigger.current?.focus();};
 },[open]);
 useEffect(()=>{setFailed(false);setLoaded(false);setOpen(false);},[src]);
 if(failed)return detail?<span className="ds-detail-image-status">图片不可用</span>:null;
 return <>
  <button type="button" className={'ds-product-image'+(detail?' ds-product-image-detail':'')} aria-label="查看商品图片" ref={trigger} aria-busy={detail&&!loaded||undefined} onClick={()=>setOpen(true)}>
   <img src={src} alt="" referrerPolicy="no-referrer" onLoad={()=>setLoaded(true)} onError={()=>setFailed(true)}/>
   {detail&&!loaded&&<span className="ds-detail-image-status">加载中</span>}
  </button>
  {open&&<dialog className="ds-product-preview" ref={dialog} aria-label="商品图片" onCancel={event=>{event.preventDefault();setOpen(false);}} onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
   <button type="button" aria-label="关闭商品图片" onClick={()=>setOpen(false)}><X size={24}/></button>
   <img src={src} alt="商品图片" referrerPolicy="no-referrer"/>
  </dialog>}
 </>;
}
