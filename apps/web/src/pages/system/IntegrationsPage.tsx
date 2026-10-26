import { FormEvent, useEffect, useState } from 'react';
import { createChecker } from '@kudesi/shared';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../api/client';
import { settingsApi, type IntegrationOverview } from '../../resources/api';

type Msg = { tone: 'ok' | 'error'; text: string } | null;

function Notice({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return <div role={msg.tone === 'error' ? 'alert' : 'status'} className={msg.tone === 'error' ? 'notice error' : 'notice ok-notice'}>{msg.text}</div>;
}

function QiniuCard({ data, canEdit, onSaved }: { data: IntegrationOverview; canEdit: boolean; onSaved: (d: IntegrationOverview) => void }) {
  const q = data.qiniu;
  const [form, setForm] = useState({ accessKey: q.accessKey, secretKey: '', bucket: q.bucket, zone: q.zone, domain: q.domain, isPrivate: q.isPrivate });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await settingsApi.saveQiniu({ ...form, secretKey: form.secretKey || undefined }));
      set({ secretKey: '' });
      setMsg({ tone: 'ok', text: '已保存。可以点“测试连接”确认参数是否正确。' });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? err.message : '保存失败' });
    }
    setBusy(false);
  }
  async function test() {
    setBusy(true);
    try {
      const r = await settingsApi.testQiniu();
      setMsg({ tone: r.ok ? 'ok' : 'error', text: r.message });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? err.message : '测试失败' });
    }
    setBusy(false);
  }

  return (
    <form className="card settings-card" onSubmit={save} aria-label="七牛云存储">
      <div className="between"><h2 className="section-title">七牛云存储（图片、附件）</h2>{q.configured ? <span className="pill ok">已配置</span> : <span className="pill warn">未配置</span>}</div>
      <label>AccessKey<input value={form.accessKey} onChange={(e) => set({ accessKey: e.target.value })} disabled={!canEdit} autoComplete="off" /></label>
      <label>SecretKey<input type="password" value={form.secretKey} placeholder={q.secretKeyConfigured ? '已设置，留空表示不修改' : ''} onChange={(e) => set({ secretKey: e.target.value })} disabled={!canEdit} autoComplete="new-password" /></label>
      <label>空间名（Bucket）<input value={form.bucket} onChange={(e) => set({ bucket: e.target.value })} disabled={!canEdit} /></label>
      <label>存储区域
        <select value={form.zone} onChange={(e) => set({ zone: e.target.value })} disabled={!canEdit}>
          {data.zones.map((z) => <option key={z.value} value={z.value}>{z.label}（{z.value}）</option>)}
        </select>
      </label>
      <label>外链域名（带 https://）<input value={form.domain} placeholder="https://cdn.example.com" onChange={(e) => set({ domain: e.target.value })} disabled={!canEdit} /></label>
      <label className="check"><input type="checkbox" checked={form.isPrivate} onChange={(e) => set({ isPrivate: e.target.checked })} disabled={!canEdit} style={{ width: 'auto', height: 'auto' }} /> 私有空间（下载链接带签名，推荐）</label>
      <Notice msg={msg} />
      {canEdit && (
        <div className="row-actions">
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
          <button type="button" className="secondary-button" disabled={busy || !q.configured} onClick={test}>测试连接</button>
        </div>
      )}
    </form>
  );
}

function VisionCard({ data, canEdit, onSaved }: { data: IntegrationOverview; canEdit: boolean; onSaved: (d: IntegrationOverview) => void }) {
  const v = data.vision;
  const [form, setForm] = useState({ baseUrl: v.baseUrl, apiKey: '', model: v.model, enabled: v.enabled });
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      onSaved(await settingsApi.saveVision({ ...form, apiKey: form.apiKey || undefined }));
      set({ apiKey: '' });
      setMsg({ tone: 'ok', text: '已保存。' });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? err.message : '保存失败' });
    }
    setBusy(false);
  }
  async function test() {
    setBusy(true);
    try {
      const r = await settingsApi.testVision();
      setMsg({ tone: r.ok ? 'ok' : 'error', text: r.message });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? err.message : '测试失败' });
    }
    setBusy(false);
  }

  return (
    <form className="card settings-card" onSubmit={save} aria-label="识别大模型">
      <div className="between"><h2 className="section-title">识别大模型（营业执照识别）</h2>{v.configured && v.enabled ? <span className="pill ok">已启用</span> : <span className="pill warn">未启用</span>}</div>
      <p className="muted">填写任意兼容 OpenAI 接口格式、支持图片输入的模型服务。</p>
      <label>接口地址<input value={form.baseUrl} placeholder="https://api.openai.com/v1" onChange={(e) => set({ baseUrl: e.target.value })} disabled={!canEdit} /></label>
      <label>API Key<input type="password" value={form.apiKey} placeholder={v.apiKeyConfigured ? '已设置，留空表示不修改' : ''} onChange={(e) => set({ apiKey: e.target.value })} disabled={!canEdit} autoComplete="new-password" /></label>
      <label>模型名<input value={form.model} placeholder="如 gpt-4o" onChange={(e) => set({ model: e.target.value })} disabled={!canEdit} /></label>
      <label className="check"><input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} disabled={!canEdit} style={{ width: 'auto', height: 'auto' }} /> 启用识别</label>
      <Notice msg={msg} />
      {canEdit && (
        <div className="row-actions">
          <button type="submit" className="primary-button" disabled={busy}>保存</button>
          <button type="button" className="secondary-button" disabled={busy || !v.configured} onClick={test}>测试连接</button>
        </div>
      )}
    </form>
  );
}

export function IntegrationsPage() {
  const { user } = useAuth();
  const canEdit = user ? createChecker(user.permissions)('system.integrations.edit') : false;
  const [data, setData] = useState<IntegrationOverview | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    settingsApi.overview().then(setData).catch((e) => setError(e instanceof ApiError ? e.message : '加载失败'));
  }, []);
  return (
    <div className="stack">
      <div className="page-head"><h1>接口设置</h1></div>
      {error && <div role="alert" className="notice error">{error}</div>}
      {data && (
        <div className="settings-grid">
          <QiniuCard data={data} canEdit={canEdit} onSaved={setData} />
          <VisionCard data={data} canEdit={canEdit} onSaved={setData} />
        </div>
      )}
      <p className="muted">密钥保存后加密存放，页面和接口都不会再返回；要修改密钥，直接重新填写即可。</p>
    </div>
  );
}
