import { useState } from 'react';
import { ApiError } from '../../api/client';
import { skuBatchApi } from './SkuApply';

/** 没拆开办理的一张 SKU 申请里，只退回有问题的规格：被退回的拆出成新流程回到申请人，其余规格继续往下走。 */
export function ReturnSpecsDialog({ run, specNames, onClose, onDone }: {
  run: { id: number; revision: number; stepId: number }; specNames: string[]; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (n: string) => setPicked((c) => { const x = new Set(c); if (x.has(n)) x.delete(n); else x.add(n); return x; });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked.size) return setError('请勾选要退回的规格');
    if (reason.trim().length < 2) return setError('请填写退回原因（至少 2 个字）');
    setBusy(true);
    setError('');
    try {
      const r = await skuBatchApi.returnSpecs({ runId: run.id, revision: run.revision, stepId: run.stepId, specs: [...picked], reason: reason.trim() });
      onDone(r.split ? `已退回 ${picked.size} 个规格（拆出为申请 #${r.newRunId}），其余规格继续办理` : '全部规格已退回申请人');
    } catch (err) { setError(err instanceof ApiError ? err.message : '退回失败'); } finally { setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card small" role="dialog" aria-label="退回部分规格" onSubmit={submit}>
        <div className="modal-head"><strong>退回部分规格</strong></div>
        <div className="modal-body">
          <p className="muted">勾选有问题的规格退回给申请人；没勾选的规格继续往下办理。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          <ul className="plain-list">
            {specNames.map((n) => <li key={n}><label className="check"><input type="checkbox" checked={picked.has(n)} onChange={() => toggle(n)} /> {n}</label></li>)}
          </ul>
          <label>退回原因（必填）<textarea rows={3} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>退回</button>
        </div>
      </form>
    </div>
  );
}
