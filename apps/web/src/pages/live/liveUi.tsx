import { ReactNode, useEffect } from 'react';
import type { Person, Preview, RoleAmount } from './liveApi';
import { SCHEDULE_TONE, SESSION_TONE, money, ratePct } from './liveFormat';
import './live.css';

/** 弹窗：点遮罩不关闭（避免误触丢数据），Esc 关闭。 */
export function Modal({ title, onClose, children, foot, size = '' }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; size?: '' | 'small' | 'wide' }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop">
      <div className={`modal card ${size}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head between"><h2>{title}</h2><button type="button" className="link-button" onClick={onClose} aria-label="关闭">关闭</button></div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export const SessionPill = ({ status, label }: { status: string; label: string }) => <span className={`pill ${SESSION_TONE[status] ?? ''}`}>{label}</span>;
export const SchedulePill = ({ status, label }: { status: string; label: string }) => <span className={`pill ${SCHEDULE_TONE[status] ?? ''}`}>{label}</span>;

export const names = (...p: Array<Person | null | undefined>) => p.filter(Boolean).map((x) => x!.name).join(' / ');

/** 预估/试算的各角色金额一行 */
export function RoleAmounts({ anchor, control, operator }: { anchor?: RoleAmount | null; control?: RoleAmount | null; operator?: RoleAmount | null }) {
  const rows: Array<[string, RoleAmount | null | undefined]> = [['主播', anchor], ['中控', control], ['运营', operator]];
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return <ul className="live-amounts">{shown.map(([label, v]) => <li key={label}><span>{label}</span><strong>{money(v!.amountCents)}</strong><small>{ratePct(v!.rateUnits)}</small></li>)}</ul>;
}

export function PreviewBox({ preview }: { preview: Preview | null }) {
  if (!preview) return null;
  if (!preview.available) return <p className="muted">预估提成：{preview.reason}</p>;
  return (
    <div className="live-preview" aria-label="预估提成">
      <strong>预估提成（以主播所报销售额 {money(preview.basisSalesCents)} 试算，审核后以审核结果为准）</strong>
      {preview.belowRoi && <span className="pill warn">投产不足，已按规则扣减点数</span>}
      <RoleAmounts anchor={preview.anchor} control={preview.control} operator={preview.operator} />
    </div>
  );
}
