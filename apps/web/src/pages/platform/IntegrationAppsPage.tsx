import { useCallback, useEffect, useState } from 'react';
import { PLATFORM_INTEGRATIONS, PLATFORM_INTEGRATION_ENVIRONMENTS, type PlatformIntegrationAppDto } from '@kudesi/shared';
import { api, ApiError } from '../../api/client';
import { SecretInput } from '../system/SecretInput';
import { fmtDateTime } from './format';

const label = (list: ReadonlyArray<{ key: string; label: string }>, k: string) => list.find((x) => x.key === k)?.label ?? k;
type Form = { integrationKey: string; environment: string; appKey: string; appSecret: string; baseUrl: string; status: 'active' | 'disabled'; remark: string; isNew: boolean };

/** 接口应用：平台统一配置聚水潭等的应用密钥（各公司再各自授权）。Secret 只写不读，列表里 Key 也只显示脱敏样子。 */
export function IntegrationAppsPage() {
  const [rows, setRows] = useState<PlatformIntegrationAppDto[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<PlatformIntegrationAppDto[]>('/platform/integration-apps').then((r) => { setRows(r); setError(''); }).catch((e) => setError(e instanceof ApiError ? e.message : '读取失败')); }, []);
  useEffect(load, [load]);
  const blank = (): Form => ({ integrationKey: PLATFORM_INTEGRATIONS[0].key, environment: 'production', appKey: '', appSecret: '', baseUrl: '', status: 'active', remark: '', isNew: true });

  async function save() {
    if (!form) return;
    setError('');
    if (form.isNew && (!form.appKey.trim() || !form.appSecret.trim())) return setError('新增时 App Key 和 App Secret 都要填');
    setBusy(true);
    try {
      await api('/platform/integration-apps', { method: 'PUT', body: { integrationKey: form.integrationKey, environment: form.environment, appKey: form.appKey.trim() || undefined, appSecret: form.appSecret.trim() || undefined, baseUrl: form.baseUrl.trim() || undefined, status: form.status, remark: form.remark.trim() || undefined } });
      setForm(null); setNotice('已保存'); load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败'); }
    setBusy(false);
  }
  async function remove(r: PlatformIntegrationAppDto) {
    if (!window.confirm(`删除「${label(PLATFORM_INTEGRATIONS, r.integrationKey)} · ${label(PLATFORM_INTEGRATION_ENVIRONMENTS, r.environment)}」的应用配置？删除后这个接口无法再用平台密钥授权。`)) return;
    try { await api(`/platform/integration-apps/${r.id}`, { method: 'DELETE' }); setNotice('已删除'); load(); } catch (e) { setError(e instanceof ApiError ? e.message : '删除失败'); }
  }

  return (
    <>
      <div className="page-head"><h1>接口应用</h1><button type="button" className="primary-button" onClick={() => { setNotice(''); setForm(blank()); }}>新增应用配置</button></div>
      <p className="muted">聚水潭、飞书、海康威视等接口的应用密钥由平台统一配置，各公司再各自授权。App Secret 加密保存，保存后不会再显示。</p>
      {notice && <div role="status" className="notice ok-notice">{notice}</div>}
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="card table-scroll"><table className="data-table">
        <thead><tr><th>接口</th><th>环境</th><th>App Key</th><th>App Secret</th><th>接口地址</th><th>状态</th><th>更新时间</th><th /></tr></thead>
        <tbody>
          {rows?.length === 0 && <tr><td colSpan={8} className="muted-text">还没有配置。点右上角“新增应用配置”。</td></tr>}
          {rows?.map((r) => (
            <tr key={r.id}>
              <td>{label(PLATFORM_INTEGRATIONS, r.integrationKey)}</td><td>{label(PLATFORM_INTEGRATION_ENVIRONMENTS, r.environment)}</td>
              <td>{r.appKeyMasked}</td><td>{r.secretConfigured ? '已设置' : '未设置'}</td><td>{r.baseUrl ?? '默认'}</td>
              <td>{r.status === 'active' ? '启用' : '已停用'}</td><td>{fmtDateTime(r.updatedAt)}</td>
              <td className="row-actions">
                <button type="button" className="link-button" onClick={() => { setNotice(''); setForm({ integrationKey: r.integrationKey, environment: r.environment, appKey: '', appSecret: '', baseUrl: r.baseUrl ?? '', status: r.status, remark: r.remark ?? '', isNew: false }); }}>修改</button>
                <button type="button" className="link-button" onClick={() => remove(r)}>删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>
      {form && (
        <div className="modal-backdrop" role="presentation">
          <form className="modal card small" role="dialog" aria-label="接口应用配置" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="modal-head"><strong>{form.isNew ? '新增应用配置' : '修改应用配置'}</strong></div>
            <div className="modal-body">
              <label>接口<select value={form.integrationKey} disabled={!form.isNew} onChange={(e) => setForm({ ...form, integrationKey: e.target.value })}>{PLATFORM_INTEGRATIONS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></label>
              <label>环境<select value={form.environment} disabled={!form.isNew} onChange={(e) => setForm({ ...form, environment: e.target.value })}>{PLATFORM_INTEGRATION_ENVIRONMENTS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}</select></label>
              <label>App Key{form.isNew ? ' *' : ''}<SecretInput value={form.appKey} placeholder={form.isNew ? '' : '已设置，留空表示不修改'} onChange={(e) => setForm({ ...form, appKey: e.target.value })} /></label>
              <label>App Secret{form.isNew ? ' *' : ''}<SecretInput value={form.appSecret} placeholder={form.isNew ? '' : '已设置，留空表示不修改'} onChange={(e) => setForm({ ...form, appSecret: e.target.value })} /></label>
              <label>接口地址（选填，不填用默认）<input value={form.baseUrl} placeholder="https://" onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} /></label>
              <label>状态<select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'disabled' })}><option value="active">启用</option><option value="disabled">停用</option></select></label>
              <label>备注（选填）<input value={form.remark} maxLength={200} onChange={(e) => setForm({ ...form, remark: e.target.value })} /></label>
              {error && <div role="alert" className="notice error">{error}</div>}
            </div>
            <div className="modal-foot"><button type="button" className="secondary-button" onClick={() => setForm(null)}>取消</button><button type="submit" className="primary-button" disabled={busy}>保存</button></div>
          </form>
        </div>
      )}
    </>
  );
}
