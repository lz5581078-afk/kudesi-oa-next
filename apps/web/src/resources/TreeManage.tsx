import { useEffect, useState } from 'react';
import { ApiError } from '../api/client';
import { resourceApi } from './api';
import { clearRefCache } from './RecordForm';
import { clearTreeNodes } from './treeNodes';

/** 管理目录要用的几个小弹窗：填原因的删除确认、分类参数配置。 */

export function ReasonDialog({ title, hint, confirmLabel, danger = true, onClose, onSubmit }: { title: string; hint: string; confirmLabel: string; danger?: boolean; onClose: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 2) return setError('请填写原因（至少 2 个字）');
    setBusy(true);
    setError('');
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={title} onSubmit={submit}>
        <div className="modal-head"><strong>{title}</strong></div>
        <div className="modal-body">
          <p className="muted">{hint}</p>
          <label>原因<b className="req"> *</b><textarea rows={3} autoFocus maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className={danger ? 'primary-button danger-fill' : 'primary-button'} disabled={busy}>{busy ? '处理中…' : confirmLabel}</button>
        </div>
      </form>
    </div>
  );
}

/** 分类参数配置：这个分类下的资产要填哪些参数（CPU、内存、序列号…），一行一个。 */
export function ParamsDialog({ target, id, name, onClose, onSaved }: { target: string; id: number; name: string; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    resourceApi.get(target, id).then((r) => setRows(String(r.data.customFields ?? '').split(/[，,\n]/).map((x) => x.trim()).filter(Boolean))).catch(() => setError('加载失败'));
  }, [target, id]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const list = (rows ?? []).map((x) => x.trim()).filter(Boolean);
    if (new Set(list).size !== list.length) return setError('参数名称不能重复');
    if (list.some((x) => /[，,]/.test(x))) return setError('参数名称里不能带逗号');
    setBusy(true);
    setError('');
    try {
      await resourceApi.update(target, id, { customFields: list.join(',') });
      clearRefCache(target);
      clearTreeNodes(target);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label={`${name}参数配置`} onSubmit={save}>
        <div className="modal-head"><strong>{name} 参数配置</strong></div>
        <div className="modal-body">
          <p className="muted">一行一个参数，例如 CPU、内存、硬盘、系统、序列号。该分类（含新建）的资产表单里会出现这些输入项。</p>
          {!rows && !error && <p className="muted">加载中…</p>}
          {rows?.map((v, i) => (
            <div key={i} className="tm-param">
              <input aria-label={`参数${i + 1}`} value={v} placeholder="参数名称" maxLength={30} autoFocus={i === rows.length - 1 && v === ''} onChange={(e) => setRows(rows.map((x, j) => (j === i ? e.target.value : x)))} />
              <button type="button" className="link-button danger" onClick={() => setRows(rows.filter((_, j) => j !== i))}>删除</button>
            </div>
          ))}
          {rows && rows.length === 0 && <p className="muted">暂无参数，点下面的“新增参数”。</p>}
          {rows && <button type="button" className="secondary-button" onClick={() => setRows([...rows, ''])}>新增参数</button>}
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy || !rows}>{busy ? '保存中…' : '保存参数'}</button>
        </div>
      </form>
    </div>
  );
}
