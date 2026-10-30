import { useState } from 'react';
import { X } from 'lucide-react';
import { createChecker } from '@kudesi/shared';
import { useAuth } from '../auth/AuthContext';
import { resourceApi, type ResourceDto } from './api';
import './bundleProfileEditor.css';

export function BundleProfileEditor({ record, onClose, onSaved }: { record: ResourceDto; onClose: () => void; onSaved: (row: ResourceDto) => void }) {
  const { user } = useAuth();
  const canStatus = !!user && createChecker(user.permissions)('resource.finance-bundles.disable');
  const [name, setName] = useState(String(record.data.name ?? '')), [shortName, setShortName] = useState(String(record.data.shortName ?? ''));
  const [status, setStatus] = useState(record.status === 'inactive' ? 'inactive' : 'active'), [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault(); if (busy) return;
    if (!name.trim() || !shortName.trim()) return setError('商品名称和商品简称必填。');
    if (status === 'inactive' && record.status !== 'inactive' && reason.trim().length < 2) return setError('请填写停用原因（至少2个字）。');
    setBusy(true); setError('');
    try { onSaved(await resourceApi.confirmBundleProfile(record.id, { name, shortName, status, statusReason: reason })); } catch (e) { setError(e instanceof Error ? e.message : '保存失败'); setBusy(false); }
  }
  return <div className="bundle-profile-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><form className="bundle-profile-editor" role="dialog" aria-modal="true" aria-label="修改商品组合编码" onSubmit={save}><header><div><h2>修改商品组合编码</h2><p>{String(record.data.code ?? record.title)}{record.refLabels.platformId ? ` · ${record.refLabels.platformId}` : ''}</p></div><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={20} /></button></header><div className="bundle-profile-body"><label>商品名称 *<input value={name} maxLength={300} onChange={e => setName(e.target.value)} /></label><label>商品简称 *<input value={shortName} maxLength={160} onChange={e => setShortName(e.target.value)} /></label><label>状态 *<select value={status} disabled={!canStatus || busy} onChange={e => setStatus(e.target.value)}><option value="active">启用</option><option value="inactive">停用</option></select></label>{status === 'inactive' && record.status !== 'inactive' && <label>停用原因<textarea maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>}<p>组合编码、平台和组成商品暂不在这里修改。</p>{error && <div className="notice error" role="alert">{error}</div>}</div><footer><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? '保存中…' : '保存修改'}</button></footer></form></div>;
}
