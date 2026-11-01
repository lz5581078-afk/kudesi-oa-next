import { useEffect, useId, useRef, type ReactNode } from 'react';

/** 财务工作弹窗：焦点留在弹窗内，关闭后回到入口。 */
export function FinanceModal({ title, onClose, busy = false, children }: { title: string; onClose: () => void; busy?: boolean; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const working = useRef(busy); working.current = busy;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('[role="dialog"]') !== panel.current) return;
      if (e.key === 'Escape' && !working.current) { e.preventDefault(); e.stopPropagation(); close.current(); }
      if (e.key !== 'Tab') return;
      const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? []).filter(n => n.getAttribute('type') !== 'hidden' && !n.hidden);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { e.preventDefault(); first.focus(); }
    };
    panel.current?.addEventListener('keydown', keydown);
    const element = panel.current;
    return () => { element?.removeEventListener('keydown', keydown); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><section ref={panel} className="card modal wide" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
    <header className="modal-head between"><h2 id={titleId}>{title}</h2><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></header>
    <div className="modal-body">{children}</div>
  </section></div>;
}
