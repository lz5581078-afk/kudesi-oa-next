import { FormEvent, useState } from 'react';
import { orgApi, DUTY_CATEGORIES, type DutyDto } from './orgApi';
import { errText } from './OrgDialogs';

/** 岗位条目（职责、培训、考核、监督规则、流程节点说明等）的新增/编辑。 */
export function DutyDialog({ positionId, duty, category, onClose, onSaved }: { positionId: number; duty: DutyDto | null; category: string; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    category: duty?.category ?? category, title: duty?.title ?? '', description: duty?.description ?? '', frequency: duty?.frequency ?? '',
    relatedModule: duty?.relatedModule ?? '', completionStandard: duty?.completionStandard ?? '', isKey: duty?.isKey ?? false,
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.title.trim()) return setError('请填写标题');
    setBusy(true);
    try {
      if (duty) await orgApi.updateDuty(duty.id, f); else await orgApi.addDuty(positionId, f);
      onSaved();
    } catch (err) { setError(errText(err)); setBusy(false); }
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal card" role="dialog" aria-label={duty ? '编辑条目' : '新增条目'} onSubmit={submit}>
        <div className="modal-head"><strong>{duty ? '编辑条目' : '新增条目'}</strong><small className="muted">同一张表承接岗位职责、入职培训、绩效考核、监督规则和流程节点说明</small></div>
        <div className="modal-body">
          <div className="form-grid">
            <label>分类<select value={f.category} onChange={(e) => set('category', e.target.value)}>{DUTY_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label>标题<input autoFocus value={f.title} maxLength={150} onChange={(e) => set('title', e.target.value)} /></label>
            <label>周期/频率<input value={f.frequency} maxLength={60} placeholder="如：每日 / 每周一 / 入职第1天" onChange={(e) => set('frequency', e.target.value)} /></label>
            <label>关联模块<input value={f.relatedModule} maxLength={60} placeholder="如：店铺资料、售后、财务" onChange={(e) => set('relatedModule', e.target.value)} /></label>
          </div>
          <label>内容说明<textarea rows={3} maxLength={1000} value={f.description} onChange={(e) => set('description', e.target.value)} /></label>
          <label>完成标准<textarea rows={2} maxLength={1000} value={f.completionStandard} onChange={(e) => set('completionStandard', e.target.value)} /></label>
          <label className="check-line"><input type="checkbox" checked={f.isKey} onChange={(e) => set('isKey', e.target.checked)} />重点条目</label>
          {error && <div role="alert" className="notice error">{error}</div>}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
        </div>
      </form>
    </div>
  );
}
