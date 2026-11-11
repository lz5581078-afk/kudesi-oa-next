import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type {DesktopSourcePanel} from './desktopBridge';

export function DesktopAfterSalesPopup({title, anchor, panelKind, footer, hideFooter, onClose, children}: {
  title: string;
  anchor?: HTMLButtonElement | null;
  panelKind?: DesktopSourcePanel;
  footer?: ReactNode;
  hideFooter?:boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(()=>{
    const element=panel.current;
    if (!element) return;
    if (!anchor) {
      const previousFocus=document.activeElement;
      const dialog=element as HTMLDialogElement;
      if (typeof dialog.showModal==='function') dialog.showModal();
      else dialog.setAttribute('open','');
      return ()=>{
        if (dialog.open && typeof dialog.close==='function') dialog.close();
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      };
    }

    function position() {
      if (!anchor?.isConnected) { close.current(); return; }
      const box=anchor.getBoundingClientRect();
      const width=element!.offsetWidth;
      const height=element!.offsetHeight;
      element!.style.left=Math.max(8,Math.min(box.left,window.innerWidth-width-8))+'px';
      const fitsBelow=box.bottom+height+16<=window.innerHeight;
      element!.style.top=Math.max(8,fitsBelow?box.bottom+8:box.top-height-8)+'px';
      element!.dataset.placement=fitsBelow?'bottom':'top';
      element!.style.setProperty('--ds-arrow-left',Math.max(16,Math.min(box.left+box.width/2-parseFloat(element!.style.left),width-16))+'px');
    }
    function outside(event:PointerEvent) {
      if (event.target instanceof Node && !element!.contains(event.target) && !anchor?.contains(event.target)) close.current();
    }
    function escape(event:KeyboardEvent) { if (event.key==='Escape') close.current(); }
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(position):undefined;
    observer?.observe(element);
    position();
    document.addEventListener('pointerdown',outside);
    document.addEventListener('keydown',escape);
    window.addEventListener('resize',position);
    window.addEventListener('scroll',position,true);
    return ()=>{
      observer?.disconnect();
      document.removeEventListener('pointerdown',outside);
      document.removeEventListener('keydown',escape);
      window.removeEventListener('resize',position);
      window.removeEventListener('scroll',position,true);
    };
  },[anchor]);

  if (anchor) return <section ref={panel} className="ds-source-popover" data-panel-kind={panelKind} role="dialog" aria-label={title}>{children}</section>;
  return <dialog ref={panel as React.RefObject<HTMLDialogElement>} className="ds-source-dialog" data-panel-kind={panelKind} aria-label={title}
    onCancel={event=>{event.preventDefault();onClose();}}>
    <div className="ds-source-dialog-heading"><h3>{title}</h3><button type="button" autoFocus aria-label="关闭售后详情" onClick={onClose}><X size={17}/></button></div>
    <div className="ds-source-dialog-body">{children}</div>
    {!hideFooter&&<footer className="ds-source-dialog-footer"><div>{footer}</div><button type="button" onClick={onClose}>关闭</button></footer>}
  </dialog>;
}
