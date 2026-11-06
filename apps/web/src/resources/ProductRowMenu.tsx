import {ChevronDown} from 'lucide-react';
import {useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';

/** Portaled so the table's horizontal scroller cannot clip row actions. */
export function ProductRowMenu({title,children}:{title:string;children:ReactNode}){
  const [open,setOpen]=useState(false);
  const [position,setPosition]=useState({top:0,left:0});
  const trigger=useRef<HTMLButtonElement>(null);
  const panel=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(!open||!trigger.current||!panel.current)return;
    const rect=trigger.current.getBoundingClientRect(),menu=panel.current.getBoundingClientRect();
    setPosition({left:Math.max(8,Math.min(rect.right-menu.width,window.innerWidth-menu.width-8)),top:rect.bottom+menu.height+8<=window.innerHeight?rect.bottom+4:Math.max(8,rect.top-menu.height-4)});
    panel.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({preventScroll:true});
  },[open]);
  useEffect(()=>{
    if(!open)return;
    const outside=(e:PointerEvent)=>{if(!panel.current?.contains(e.target as Node)&&!trigger.current?.contains(e.target as Node))setOpen(false);};
    const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setOpen(false);trigger.current?.focus({preventScroll:true});}};
    const moved=(e:Event)=>{if(!(e.target instanceof Node)||!panel.current?.contains(e.target))setOpen(false);};
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape,true);
    window.addEventListener('scroll',moved,true);
    window.addEventListener('resize',moved);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);window.removeEventListener('scroll',moved,true);window.removeEventListener('resize',moved);};
  },[open]);
  return <>
    <button ref={trigger} type="button" className="product-row-menu-trigger" aria-label={`操作：${title}`} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>操作<ChevronDown/></button>
    {open&&createPortal(<div ref={panel} className="product-row-menu" role="dialog" aria-label={`操作：${title}`} style={position} onClick={e=>{
      e.stopPropagation();
      // Let the action run before removing its button from the DOM.
      if((e.target as Element).closest('button:not(:disabled)'))setOpen(false);
    }} onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget as Node)&&e.relatedTarget!==trigger.current)setOpen(false);}}>{children}</div>,document.body)}
  </>;
}
