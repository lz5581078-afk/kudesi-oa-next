import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * 工具条上的浮层（筛选、显示列、更多、导出）：点按钮开合，点外面或按 Esc 收起。
 * 电脑上贴着按钮下方弹出；手机上变成从底部升起的抽屉（样式见 .res-pop）。
 */
export function ToolPop({ label, trigger, className, panelClass, align = 'left', sheet = true, children, onOpenChange }: {
  label: string;
  trigger: ReactNode;
  className?: string;
  panelClass?: string;
  align?: 'left' | 'right';
  /** 手机上是否变成底部抽屉（说明气泡不需要） */
  sheet?: boolean;
  children: (close: () => void) => ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const set = (v: boolean) => { setOpen(v); onOpenChange?.(v); };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) { setOpen(false); onOpenChange?.(false); } };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); onOpenChange?.(false); } };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, onOpenChange]);
  return (
    <div className="res-pop-wrap" ref={wrap}>
      <button type="button" className={className ?? 'res-btn'} aria-haspopup="dialog" aria-expanded={open} aria-label={label} onClick={() => set(!open)}>{trigger}</button>
      {open && (
        <>
          {sheet && <div className="res-pop-scrim" aria-hidden="true" onClick={() => set(false)} />}
          <div className={`res-pop ${align === 'right' ? 'right' : ''} ${panelClass ?? ''}`} role="dialog" aria-label={label}>
            {sheet && <div className="res-pop-grab" aria-hidden="true" />}
            {children(() => set(false))}
          </div>
        </>
      )}
    </div>
  );
}
