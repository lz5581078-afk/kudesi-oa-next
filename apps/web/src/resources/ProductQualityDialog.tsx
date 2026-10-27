import { useEffect, useId, useState } from 'react';
import { archiveQualityFields, archiveQualityIssues, mergeQualityReasons, parseQualityReasons, unitYuanText, type QualityField, type QualityOptions } from '@kudesi/shared';
import { resourceApi } from './api';
import { ReasonLibraryDialog } from './ReasonLibraryDialog';

const MONEY = new Set(['purchasePrice', 'freight', 'handlingFee']);
const confirmLabel = (f: QualityField) => (f.mode === 'weight' ? '确认不计重量' : f.mode === 'optionalGroup' ? '确认不需要' : '确认该项为0');

function valueText(f: QualityField, confirmedReason: string | undefined): string {
  if (confirmedReason) return `已确认：${confirmedReason}`;
  if (f.value === null || f.value === undefined || String(f.value).trim() === '') return '未填写';
  const n = Number(f.value);
  if (n === 0) return '0 · 待确认';
  if (MONEY.has(f.id)) return `${unitYuanText(n)} 元`;
  return `${f.value}${f.unit ? ` ${f.unit}` : ''}`;
}

/**
 * 核算资料确认（旧 ArchiveQualityConfirmation）：保存商品档案前，逐项列出采购价、运费、装卸费、重量、包装/人力组成等，
 * 填 0 或空的要选或写原因后“确认该项为0”；下面列出还没完成的项目，没有未完成项才能“确认并保存”。
 * 原因写进档案的“零值说明”（每项一行）。
 */
export function ProductQualityDialog({ values, options, onCancel, onConfirm }: {
  values: Record<string, unknown>;
  options: QualityOptions;
  onCancel: () => void;
  onConfirm: (next: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState<Record<string, unknown>>(values);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [library, setLibrary] = useState<string[]>([]);
  const [managing, setManaging] = useState(false);
  const listId = useId();
  const loadLibrary = () => resourceApi.list('finance-zero-reasons', { page: 1, pageSize: 200 }).then((r) => setLibrary(r.items.map((i) => i.title))).catch(() => undefined);
  useEffect(() => { void loadLibrary(); }, []);
  const issues = archiveQualityIssues(form, options);
  const reasons = parseQualityReasons(form.zeroValueReason);
  const rows = archiveQualityFields(form, options).filter((f) => ['zero', 'weight', 'optionalGroup'].includes(f.mode));

  function confirmRow(f: QualityField) {
    const reason = (drafts[f.id] ?? '').trim();
    if (!reason) return;
    const next: Record<string, unknown> = { ...form, zeroValueReason: mergeQualityReasons(form.zeroValueReason, { [f.label]: reason }) };
    if (f.mode === 'zero' || f.mode === 'weight') next[f.id] = 0;
    if (f.mode === 'weight') next.weightManual = true;
    setForm(next);
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal card small" role="dialog" aria-modal="true" aria-label="核算资料确认">
        <div className="modal-head between"><strong>核算资料确认</strong><button type="button" className="icon-button" aria-label="返回修改" onClick={onCancel}>✕</button></div>
        <div className="modal-body">
          <div className="between"><span className="muted">{String(form.name ?? '')}</span><button type="button" className="link-button" onClick={() => setManaging(true)}>管理零值原因</button></div>
          <datalist id={listId}>{library.map((r) => <option key={r} value={r} />)}</datalist>
          {rows.length === 0 && <p className="muted">没有需要确认的核算项目。</p>}
          {rows.map((f) => {
            const reason = reasons[f.label];
            const n = f.value === null || f.value === undefined || String(f.value).trim() === '' ? null : Number(f.value);
            const confirmed = Boolean(reason) && n === 0;
            const needs = !confirmed && (n === null || n === 0) && f.mode !== 'positive';
            // 原料、发货物料的采购价取自供货来源，空着不用确认
            const optionalBlank = f.id === 'purchasePrice' && n === null && ['raw', 'shipping_material'].includes(String(form.archiveType));
            return (
              <div key={f.id} className="between" style={{ flexWrap: 'wrap', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--line, #e3e8ee)' }}>
                <strong style={{ minWidth: 90 }}>{f.label}</strong>
                <span>{optionalBlank ? '取自供货来源' : valueText(f, confirmed ? reason : undefined)}</span>
                {needs && !optionalBlank && (
                  <span className="pill-row">
                    <input list={listId} maxLength={180} placeholder="选择或输入原因" aria-label={`${f.label}零值原因`} value={drafts[f.id] ?? ''} onChange={(e) => setDrafts({ ...drafts, [f.id]: e.target.value })} />
                    <button type="button" className="secondary-button" disabled={!(drafts[f.id] ?? '').trim()} onClick={() => confirmRow(f)}>{confirmLabel(f)}</button>
                  </span>
                )}
              </div>
            );
          })}
          {issues.length > 0 && (
            <div className="notice warn" role="status"><strong>尚未完成的项目</strong>
              <ul>{issues.map((i, idx) => <li key={`${i.id}-${idx}`}>{i.message}</li>)}</ul>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onCancel}>返回修改</button>
          <button type="button" className="primary-button" disabled={issues.length > 0} onClick={() => onConfirm(form)}>确认并保存</button>
        </div>
      </div>
      {managing && <ReasonLibraryDialog libType="finance-zero-reasons" title="零值原因" onClose={() => { setManaging(false); void loadLibrary(); }} />}
    </div>
  );
}
