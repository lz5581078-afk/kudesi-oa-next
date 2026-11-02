import { createPortal } from 'react-dom';
import { ReactNode, useEffect, useState, useRef } from 'react';
import { liveApi, type Person, type Preview, type RoleAmount, type SourceStatus } from './liveApi';
import { SCHEDULE_TONE, SESSION_TONE, money, ratePct } from './liveFormat';
import './live.css';

/** 弹窗：点遮罩不关闭（避免误触丢数据），Esc 关闭。 */
export function Modal({ title, onClose, children, foot, size = '', bodyClassName = '' }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; size?: '' | 'small' | 'wide'; bodyClassName?: string }) {
  const dialogRef=useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const dialogs=document.querySelectorAll('[role=dialog]');
      if (dialogs[dialogs.length-1]!==dialogRef.current) return;
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length);
        const first=controls[0], last=controls[controls.length-1];
        if (!first) { e.preventDefault(); return; }
        if (e.shiftKey && (document.activeElement===first || document.activeElement===dialogRef.current)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement===last || document.activeElement===dialogRef.current)) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop live-modal-backdrop">
      <div ref={dialogRef} tabIndex={-1} className={`modal card live-modal ${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head between"><h2>{title}</h2><button type="button" className="link-button" onClick={onClose} aria-label="关闭">关闭</button></div>
        <div className={`modal-body ${bodyClassName}`}>{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>,document.body
  );
}

export const SessionPill = ({ status, label }: { status: string; label: string }) => <span className={`pill ${SESSION_TONE[status] ?? ''}`}>{label}</span>;
export const SchedulePill = ({ status, label }: { status: string; label: string }) => <span className={`pill ${SCHEDULE_TONE[status] ?? ''}`}>{label}</span>;

export const names = (...p: Array<Person | null | undefined>) => p.filter(Boolean).map((x) => x!.name).join(' / ');

/** 预估/试算的各角色金额一行 */
export function RoleAmounts({ anchor, control, operator, hideRates=false }: { hideRates?:boolean; anchor?: RoleAmount | null; control?: RoleAmount | null; operator?: RoleAmount | null }) {
  const rows: Array<[string, RoleAmount | null | undefined]> = [['主播', anchor], ['中控', control], ['运营', operator]];
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return <ul className="live-amounts">{shown.map(([label, v]) => <li key={label}><span>{label}</span><strong>{money(v!.amountCents)}</strong>{!hideRates&&<small>{ratePct(v!.rateUnits)}</small>}</li>)}</ul>;
}

export function PreviewBox({ preview }: { preview: Preview | null }) {
  if (!preview) return null;
  if (!preview.available) return <p className="muted">预估提成：{preview.reason}</p>;
  return (
    <div className="live-preview" aria-label="预估提成">
      <strong>预估提成（以主播所报销售额 {money(preview.basisSalesCents)} 试算，审核后以审核结果为准）</strong>
      {preview.belowRoi && <span className="pill warn">投产不足，已按规则扣减点数</span>}
      <RoleAmounts hideRates={preview.aggregated} anchor={preview.anchor} control={preview.control} operator={preview.operator} />
    </div>
  );
}

/** 聚水潭只读授权状态：没授权/没配置/过期时，给出明确提示和管理员要做的事，不等到报下播或月结才失败。 */
export function SourceStatusNotice() {
  const [st, setSt] = useState<SourceStatus | null>(null);
  useEffect(() => { liveApi.integrationStatus().then(setSt).catch(() => setSt(null)); }, []);
  if (!st || st.ready) return null;
  return <div role="status" className="notice warn live-source-status" tabIndex={0} data-testid="live-source-status"><strong>聚水潭订单暂时不能查询：</strong>{st.message}<span className="muted">（订单与售后核对需要有效授权；无法读取订单的店铺可填写原因，提交人工核定。）</span></div>;
}
