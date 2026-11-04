import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client';
import './resourceConfirm.css';

/** 停用/删除等需要填写原因的确认框。 */
export function ReasonDialog({ title, hint, confirmLabel, danger, requireReason = true, suggestions = ['重复录入', '录入错误', '不再使用', '信息有误'], presentation, subject, confirmationText, onClose, onConfirm }: {
  title: string; hint?: string; confirmLabel: string; danger?: boolean; requireReason?: boolean; suggestions?: string[];
  presentation?:'finance-archive'|'finance-delete'; subject?:string; confirmationText?:string;
  onClose: () => void; onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const finance=presentation==='finance-archive',financeDelete=presentation==='finance-delete';
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) { e.preventDefault(); onClose(); }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  const dialog = (
    <div className={financeDelete?'modal-backdrop resource-confirm-backdrop finance-archive-delete-backdrop':finance ? 'modal-backdrop finance-archive-reason-backdrop' : requireReason ? 'modal-backdrop' : 'modal-backdrop resource-confirm-backdrop'} role="presentation">
      <form
        className={`modal card small${requireReason ? '' : ' resource-confirm-message'}${finance?' finance-archive-reason':''}${financeDelete?' finance-archive-delete':''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          if (requireReason && reason.trim().length < (finance?1:2)) return setError(finance?'请填写停用原因':'请填写原因（至少 2 个字）');
          submitting.current = true; setBusy(true);
          try {
            await onConfirm(reason.trim());
          } catch (err) {
            setError(err instanceof ApiError ? err.message : '操作失败');
            submitting.current = false; setBusy(false);
          }
        }}
      >
        <div className="modal-head">{finance||financeDelete?<><div>{financeDelete?<h2>{title}</h2>:<strong>{title}</strong>}{hint&&(financeDelete?<p>{hint}</p>:<span>{hint}</span>)}</div><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>关闭</button></>:<>{requireReason ? <strong>{title}</strong> : <h2>{title}</h2>}{!requireReason && <button type="button" aria-label="关闭" className="icon-button" disabled={busy} onClick={onClose}>×</button>}</>}</div>
        {financeDelete?<><div className="finance-archive-delete-content"><strong>{subject}</strong><span>{confirmationText??'请确认是否删除这条资料。'}</span></div>{error&&<div className="notice error" role="alert">{error}</div>}<div className="modal-foot"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button type="submit" className="primary-button danger-fill" disabled={busy}>{confirmLabel}</button></div></>:finance?<div className="finance-archive-reason-grid"><label><span>停用原因</span><textarea value={reason} onChange={e=>{setReason(e.target.value);setError('');}}/></label>{error&&<div role="alert" className="finance-archive-reason-error"><strong>操作失败</strong><span>{error}</span></div>}<div className="finance-archive-reason-actions"><button type="submit" className="primary-button" disabled={busy}>{confirmLabel}</button><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button></div></div>:<><div className="modal-body">
          {hint && <p className={requireReason ? 'muted' : undefined}>{hint}</p>}
          {requireReason && <label>原因<textarea rows={3} autoFocus value={reason} maxLength={500} onChange={(e) => { setReason(e.target.value); setError(''); }} /></label>}
          {requireReason && suggestions.length > 0 && (
            <div className="pill-row" role="group" aria-label="常用原因">
              {suggestions.map((t) => <button key={t} type="button" className={reason.trim() === t ? 'chip active' : 'chip'} onClick={() => { setReason(t); setError(''); }}>{t}</button>)}
            </div>
          )}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" disabled={!requireReason && busy} onClick={onClose}>取消</button>
          <button type="submit" className={danger ? 'primary-button danger-fill' : 'primary-button'} disabled={busy}>{confirmLabel}</button>
        </div>
        </>}
      </form>
    </div>
  );
  return requireReason ? dialog : createPortal(dialog, document.body);
}
