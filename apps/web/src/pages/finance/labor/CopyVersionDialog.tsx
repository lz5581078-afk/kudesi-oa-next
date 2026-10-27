import { FormEvent, useState } from 'react';
import { api, ApiError } from '../../../api/client';
import type { ResourceDto } from '../../../resources/api';

/** 复制成本版本：新版本是草稿，带上原版本的归档分类和全部工作项目。 */
export function CopyVersionDialog({ source, onClose, onCopied }: { source: ResourceDto; onClose: () => void; onCopied: (newId: number) => void }) {
  const [v, setV] = useState({ versionCode: '', versionName: `${source.title}（复制）`, periodName: '', effectiveFrom: '', effectiveTo: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((o) => ({ ...o, [k]: e.target.value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ id: number }>(`/finance/labor/versions/${source.id}/copy`, { method: 'POST', body: v });
      onCopied(r.id);
    } catch (err) { setError(err instanceof ApiError ? err.message : '复制失败'); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label="复制成本版本" onSubmit={submit}>
        <div className="modal-head"><strong>复制成本版本「{source.title}」</strong></div>
        <div className="modal-body">
          <p className="muted">新版本是草稿，会带上原版本的全部归档分类和工作项目（含单价）。</p>
          {error && <div role="alert" className="notice error">{error}</div>}
          <label>新版本编号 <input aria-label="新版本编号" required value={v.versionCode} onChange={set('versionCode')} maxLength={80} /></label>
          <label>新版本名称 <input aria-label="新版本名称" required value={v.versionName} onChange={set('versionName')} maxLength={160} /></label>
          <label>期间名称 <input aria-label="期间名称" value={v.periodName} onChange={set('periodName')} maxLength={120} /></label>
          <label>生效开始 <input aria-label="生效开始" type="date" value={v.effectiveFrom} onChange={set('effectiveFrom')} /></label>
          <label>生效结束 <input aria-label="生效结束" type="date" value={v.effectiveTo} onChange={set('effectiveTo')} /></label>
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '复制中…' : '复制'}</button>
        </div>
      </form>
    </div>
  );
}
