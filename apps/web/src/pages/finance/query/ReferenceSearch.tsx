import { useEffect, useRef, useState } from 'react';
import { ListFilter, Search, X } from 'lucide-react';

import { querySearchTerms } from '@kudesi/shared';
export { querySearchTerms } from '@kudesi/shared';

/** 普通搜索保持完整短语；多条搜索按行去重，任意一条匹配。 */
export function ReferenceSearch({ value, onChange, label, placeholder = '搜索当前列表' }: { value:string; onChange:(value:string)=>void; label:string; placeholder?:string }) {
  const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),[right,setRight]=useState(false);
  const root=useRef<HTMLDivElement>(null),input=useRef<HTMLInputElement>(null);
  const terms=querySearchTerms(value), multi=terms.length>1;
  const close=()=>{setOpen(false);input.current?.focus();};
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);input.current?.focus();}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape,true);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);};
  },[open]);
  const show=()=>{const rect=root.current?.getBoundingClientRect();setRight(!!rect&&rect.left+480>window.innerWidth&&rect.right>480);setDraft(terms.join('\n'));setOpen(true);};
  return <div ref={root} className={`qk-reference-search${right?' align-right':''}`}><div className="qk-reference-search-shell"><Search size={16}/><input ref={input} aria-label={label} title="双击进行多条搜索" value={multi?'':value} placeholder={multi?`已启用 ${terms.length} 条搜索条件`:placeholder} onChange={event=>onChange(event.target.value)} onDoubleClick={show}/>{multi&&<span className="qk-reference-search-count">{terms.length}条</span>}<button type="button" aria-label="打开多条搜索" title="多条搜索" onClick={show}><ListFilter size={16}/></button></div>{open&&<section className="qk-reference-search-popover" aria-label="多条搜索"><header><div><strong>多条搜索</strong><span>每行填写一个搜索内容</span></div><button type="button" aria-label="关闭多条搜索" onClick={close}><X size={16}/></button></header><textarea aria-label="多条搜索内容" autoFocus rows={7} value={draft} onChange={event=>setDraft(event.target.value)} placeholder={'每行填写一条，例如：\n店铺A\n店铺B\n店铺C'}/><footer><span>已填写 {querySearchTerms(draft).length} 条，任意一条匹配即可</span><div><button type="button" className="secondary-button" onClick={()=>{onChange('');setDraft('');close();}}>清空</button><button type="button" className="primary-button" onClick={()=>{onChange(querySearchTerms(draft).join('\n'));close();}}>开始搜索</button></div></footer></section>}</div>;
}
