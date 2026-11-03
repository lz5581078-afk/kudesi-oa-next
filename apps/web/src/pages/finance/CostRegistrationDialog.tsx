import { X } from 'lucide-react';
import { costMoney } from './CostDialogs';
import type { CostRegisterPreview } from './financeApi';

/** 补齐先看缺失和问题清单，确认时带回同一份预览签名。 */
export function CostRegistrationDialog({ preview, busy, error, onClose, onRefresh, onConfirm }: {
  preview: CostRegisterPreview; busy: boolean; error: string; onClose: () => void; onRefresh: () => void; onConfirm: () => void;
}) {
  return <div className="modal-backdrop finance-cost-registration-backdrop"><section className="modal card finance-cost-registration" role="dialog" aria-modal="true" aria-label="补齐已验证SKU">
    <header><h2>补齐已验证SKU</h2><button type="button" className="icon-button" aria-label="关闭补齐预览" disabled={busy} onClick={onClose}><X size={18}/></button></header>
    <p>待补齐 {preview.rows.length} 条 · 需核对 {preview.issues.length} 条</p>
    <p className="muted">仅新增缺失记录，已有成本及单品设置不会覆盖。</p>
    <div className="finance-cost-registration-list">
      {preview.rows.slice(0, 100).map(row => <p key={row.id}><strong>{row.code} · {row.name}</strong><small>{costMoney(row.costCents)} · {Number((row.weightG / 1000).toFixed(6))} kg</small></p>)}
      {preview.rows.length > 100 && <p>另有 {preview.rows.length - 100} 条</p>}
      {preview.issues.map(row => <p key={row.id} className="bad-text">{row.code}：{row.issues.join('、')}</p>)}
    </div>
    {error && <p role="alert" className="bad-text">{error}</p>}
    <footer><button type="button" className="secondary-button" disabled={busy} onClick={onRefresh}>重新预览</button><button type="button" className="primary-button" disabled={busy || !preview.rows.length} onClick={onConfirm}>确认补齐 {preview.rows.length} 条</button></footer>
  </section></div>;
}
