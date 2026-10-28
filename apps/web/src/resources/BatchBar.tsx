import { useEffect, useState } from 'react';
import type { BatchAction, FieldDef, ResourceDef } from '@kudesi/shared';
import { ApiError } from '../api/client';
import { resourceApi, type ResourceDto } from './api';
import { loadRefOptions } from './RecordForm';

type Result = { done: number; failed: Array<{ id: number; message: string }> };

const failText = (r: Result) => (r.failed.length ? `，${r.failed.length} 条失败：${r.failed.slice(0, 3).map((x) => `#${x.id} ${x.message}`).join('；')}` : '');

/** 批量停用/启用 与 带原因的批量动作用的小对话框：可选一个值（pick），填原因 */
function ReasonPickDialog({ title, pickField, reasonLabel, reasonRequired, confirmLabel, suggestions, onClose, onConfirm }: {
  title: string; pickField?: FieldDef; reasonLabel: string; reasonRequired: boolean; confirmLabel: string; suggestions?: string[];
  onClose: () => void; onConfirm: (value: unknown, reason: string) => Promise<void>;
}) {
  const [options, setOptions] = useState<Array<{ value: number | string; label: string }>>([]);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!pickField) return;
    if (pickField.type === 'select') setOptions((pickField.options ?? []).map((o) => ({ value: o.value, label: o.label })));
    else if (pickField.ref) void loadRefOptions(pickField.ref).then((l) => setOptions(l.filter((o) => !(o as { disabled?: boolean }).disabled))).catch(() => setError('选项加载失败'));
  }, [pickField]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={title} onSubmit={async (e) => {
        e.preventDefault();
        if (pickField && !value) return setError(`请选择${pickField.label}`);
        if (reasonRequired && reason.trim().length < 2) return setError(`请填写${reasonLabel}（至少 2 个字）`);
        setBusy(true);
        try {
          await onConfirm(pickField ? (pickField.ref && pickField.type !== 'select' ? (pickField.type === 'refs' ? [Number(value)] : Number(value)) : value) : undefined, reason.trim());
        } catch (err) { setError(err instanceof ApiError ? err.message : '操作失败'); setBusy(false); }
      }}>
        <h3>{title}</h3>
        {pickField && (
          <label>{pickField.label}
            <select value={value} onChange={(e) => { setValue(e.target.value); setError(''); }}>
              <option value="">请选择</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
        )}
        <label>{reasonLabel}{reasonRequired ? '' : '（选填）'}
          <textarea rows={3} maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setError(''); }} />
        </label>
        {suggestions && suggestions.length > 0 && (
          <div className="pill-row">{suggestions.map((s) => <button key={s} type="button" className="chip" onClick={() => setReason(s)}>{s}</button>)}</div>
        )}
        {error && <div role="alert" className="notice error m">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '处理中…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

/**
 * 勾选后的批量操作条：批量修改字段（config.batch）、停用/启用所选（所有资料）、带原因的批量动作（config.batchActions）、导出所选。
 * 服务端逐条校验权限、状态联动和归档，这里只负责收集输入。
 */
export function BatchBar({ def, type, rows, checked, can, filterOpts, onMessage, onDone, onExport, onClear }: {
  def: ResourceDef; type: string; rows: ResourceDto[]; checked: number[];
  can: (action: 'edit' | 'disable' | 'export') => boolean;
  filterOpts: Record<string, Array<{ id: number | string; label: string }>>;
  onMessage: (m: string) => void; onDone: () => void; onExport: () => void; onClear: () => void;
}) {
  const [batchField, setBatchField] = useState('');
  const [batchValue, setBatchValue] = useState('');
  const [dialog, setDialog] = useState<{ kind: 'status'; status: string; label: string; requiresReason: boolean; ids: number[] } | { kind: 'action'; action: BatchAction } | null>(null);
  const batchFields = (def.batch ?? []).filter((k) => k !== 'status').map((k) => def.fields.find((f) => f.key === k)).filter((f): f is FieldDef => Boolean(f));
  const picked = rows.filter((r) => checked.includes(r.id));
  // 停用 = 停用状态（没有就取第一个隐藏状态）；启用 = 默认状态。和旧系统一样：已经是目标状态的不重复处理
  const offStatus = def.statuses.find((s) => s.value === 'inactive') ?? def.statuses.find((s) => s.hidden && s.value !== 'deleted' && s.value !== 'cancelled');
  const onStatus = def.statuses.find((s) => s.value === def.defaultStatus);
  const toOff = offStatus ? picked.filter((r) => r.status !== offStatus.value && !r.archived) : [];
  const hiddenValues = new Set(def.statuses.filter((x) => x.hidden).map((x) => x.value));
  const toOn = offStatus && onStatus ? picked.filter((r) => hiddenValues.has(r.status) && r.status !== onStatus.value && !r.archived) : [];
  const run = async (fn: () => Promise<Result>, ok: string) => {
    const r = await fn();
    onMessage(`${ok} ${r.done} 条${failText(r)}`);
    setDialog(null); onClear(); onDone();
  };

  return (
    <div className="res-batch" role="group" aria-label="批量操作">
      <strong className="res-batch-n">已勾选 {checked.length} 条</strong>
      {def.batch && can('edit') && batchFields.length > 0 && (
        <>
          <select aria-label="批量修改字段" value={batchField} onChange={(e) => { setBatchField(e.target.value); setBatchValue(''); }}>
            <option value="">批量修改…</option>
            {batchFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          {batchField && (
            <select aria-label="新的值" value={batchValue} onChange={(e) => setBatchValue(e.target.value)}>
              <option value="">选择新的值</option>
              {(filterOpts[batchField] ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          )}
          <button type="button" className="secondary-button" disabled={!batchField || !batchValue} onClick={async () => {
            const f = def.fields.find((x) => x.key === batchField);
            try {
              await run(() => resourceApi.batch(type, checked, { [batchField]: f?.type === 'refs' ? [Number(batchValue)] : f?.ref ? Number(batchValue) : batchValue }), '已修改');
            } catch (e) { onMessage(e instanceof ApiError ? e.message : '批量修改失败'); }
          }}>应用</button>
        </>
      )}
      {can('edit') && (def.batchActions ?? []).map((a) => (
        <button key={a.key} type="button" className="secondary-button" onClick={() => setDialog({ kind: 'action', action: a })}>{a.label}</button>
      ))}
      {can('disable') && offStatus && toOff.length > 0 && (
        <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'status', status: offStatus.value, label: offStatus.label, requiresReason: true, ids: toOff.map((r) => r.id) })}>停用所选（{toOff.length}）</button>
      )}
      {can('disable') && onStatus && toOn.length > 0 && (
        <button type="button" className="secondary-button" onClick={() => setDialog({ kind: 'status', status: onStatus.value, label: '启用', requiresReason: true, ids: toOn.map((r) => r.id) })}>启用所选（{toOn.length}）</button>
      )}
      {can('disable') && def.batch?.includes('status') && def.statuses
        .filter((s) => s.value !== 'deleted' && s.value !== offStatus?.value && s.value !== onStatus?.value).slice(0, 4).map((s) => (
          <button key={s.value} type="button" className="secondary-button" onClick={() => setDialog({ kind: 'status', status: s.value, label: s.label, requiresReason: Boolean(s.requiresReason), ids: checked })}>批量{s.label}</button>
        ))}
      {can('export') && <button type="button" className="secondary-button" onClick={onExport}>导出所选</button>}
      <button type="button" className="secondary-button" onClick={onClear}>取消勾选</button>
      {dialog?.kind === 'status' && (
        <ReasonPickDialog
          title={`批量${dialog.label}（${dialog.ids.length} 条）`}
          reasonLabel="原因" reasonRequired={dialog.requiresReason} confirmLabel="确定"
          suggestions={dialog.label === '启用' ? ['恢复使用', '误停用'] : ['不再使用', '重复录入', '信息有误']}
          onClose={() => setDialog(null)}
          onConfirm={async (_v, reason) => { await run(() => resourceApi.batchStatus(type, dialog.ids, dialog.status, reason || undefined), `已${dialog.label === '启用' ? '启用' : `改为${dialog.label}`}`); }}
        />
      )}
      {dialog?.kind === 'action' && (
        <ReasonPickDialog
          title={`${dialog.action.label}（${checked.length} 条）`}
          pickField={dialog.action.pick ? def.fields.find((f) => f.key === dialog.action.pick) : undefined}
          reasonLabel={dialog.action.reasonLabel ?? '原因'} reasonRequired={Boolean(dialog.action.reasonRequired)} confirmLabel="确定"
          onClose={() => setDialog(null)}
          onConfirm={async (value, reason) => { await run(() => resourceApi.batchAction(type, checked, dialog.action.key, value, reason || undefined), `${dialog.action.label}：已处理`); }}
        />
      )}
    </div>
  );
}
