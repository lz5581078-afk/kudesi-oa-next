import './WorkforcePanels.css';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../api/client';

export interface UnfiledPerson {
  id: number;
  name: string;
  account: string | null;
  employmentType: string;
  status?: 'active' | 'disabled';
  loginPassword?: string;
  feishuBound?: boolean;
  trial?: boolean;
}

const errText = (error: unknown) => error instanceof ApiError ? error.message : '操作失败';

export function WorkforceTrialDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api('/workforce/trial-people', { body: { name: name.trim() } });
      onSaved();
    } catch (failure) {
      setError(errText(failure));
    } finally {
      setBusy(false);
    }
  }
  return <div className="modal-backdrop"><form className="modal card small" role="dialog" aria-modal="true" aria-label="新增试播主播" onSubmit={save}>
    <div className="modal-head"><strong>新增试播主播</strong></div>
    <div className="modal-body workforce-login-fields">
      <label>姓名<input required maxLength={50} value={name} onChange={event => setName(event.target.value)} /></label>
      <p className="muted">先登记姓名，确认合作后可在列表里建立账号并补齐档案。</p>
      {error && <p role="alert" className="notice error">{error}</p>}
    </div>
    <div className="modal-foot">
      <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className="primary-button" disabled={busy || !name.trim()}>保存</button>
    </div>
  </form></div>;
}
