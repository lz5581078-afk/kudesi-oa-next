import { FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SecretInput } from './SecretInput';

type Settings = {
  appId: string; tenantKey: string; secretConfigured: boolean; enabled: boolean;
  morningEnabled: boolean; welcomeEnabled: boolean; morningText: string; welcomeText: string;
  departmentIds: string[]; eventConnection: string; workerRunning?: boolean; helloText?: string; helloSubmitted?: boolean;
  jobs: Array<{ id: number; kind: string; status: string; lastError?: string }>;
};

export function FeishuAssistantCard({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<Settings | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<Settings>('/settings/feishu-assistant').then(setData).catch(e => setError(e.message)); }, []);
  const patch = (p: Partial<Settings>) => { setData(old => old ? { ...old, ...p } : old); setMessage(''); };
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const { appId, tenantKey, enabled, morningEnabled, welcomeEnabled, morningText, welcomeText, departmentIds } = data;
      setData(await api<Settings>('/settings/feishu-assistant', { method: 'PUT', body: { appId, appSecret: secret || undefined, tenantKey, enabled, morningEnabled, welcomeEnabled, morningText, welcomeText, departmentIds } }));
      setSecret(''); setMessage('已保存。早安每天北京时间08:00发送；入职欢迎仅发送给新加入的员工。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setError('');
    try { setMessage((await api<{ message: string }>('/settings/feishu-assistant/test', { method: 'POST' })).message); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function hello() {
    setBusy(true); setError(''); setMessage('');
    try {
      setData(await api<Settings>('/settings/feishu-assistant/hello', { method: 'POST' }));
      setMessage('全员打招呼已加入发送队列，请查看最近发送记录；重复点击不会重复群发。');
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <form className="card settings-card" aria-label="小白OA助手自动问候" onSubmit={save}>
    <div className="between"><h2 className="section-title">小白OA 助手</h2><span className={`pill ${data?.enabled ? 'ok' : 'warn'}`}>{data?.enabled ? '已开启' : '未开启'}</span></div>
    {data && <>
      <p className="muted">每天北京时间08:00向飞书全员发送早安，新员工入职时自动收到欢迎消息。</p>
      <label>App ID<input value={data.appId} onChange={e => patch({ appId: e.target.value })} disabled={!canEdit} /></label>
      <label>App Secret<SecretInput value={secret} onChange={e => setSecret(e.target.value)} placeholder={data.secretConfigured ? '已设置，留空不修改' : '填写小白OA助手的应用密钥'} disabled={!canEdit} /></label>
      <label>企业 Tenant Key<input value={data.tenantKey} onChange={e => patch({ tenantKey: e.target.value })} disabled={!canEdit} /></label>
      <label>飞书部门范围<input value={data.departmentIds.join(',')} onChange={e => patch({ departmentIds: e.target.value.split(',').map(v => v.trim()).filter(Boolean) })} disabled={!canEdit} /><small className="muted">填0表示全员；系统会解析实际部门和直属成员。飞书应用可用范围及通讯录数据范围均需包含全体员工。</small></label>
      <label className="check"><input type="checkbox" style={{ width: 'auto' }} checked={data.enabled} onChange={e => patch({ enabled: e.target.checked })} disabled={!canEdit} />开启自动发送（关闭后停止早安和欢迎消息）</label>
      <label className="check"><input type="checkbox" style={{ width: 'auto' }} checked={data.morningEnabled} onChange={e => patch({ morningEnabled: e.target.checked })} disabled={!canEdit} />每天08:00发送早安，含周末</label>
      <label>早安消息<textarea style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 8, padding: 10, font: 'inherit', resize: 'vertical' }} rows={3} maxLength={1000} value={data.morningText} onChange={e => patch({ morningText: e.target.value })} disabled={!canEdit} /></label>
      <label className="check"><input type="checkbox" style={{ width: 'auto' }} checked={data.welcomeEnabled} onChange={e => patch({ welcomeEnabled: e.target.checked })} disabled={!canEdit} />新员工加入飞书时发送欢迎消息</label>
      <label>欢迎消息<textarea style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #d1d5db', borderRadius: 8, padding: 10, font: 'inherit', resize: 'vertical' }} rows={3} maxLength={1000} value={data.welcomeText} onChange={e => patch({ welcomeText: e.target.value })} disabled={!canEdit} /></label>
      <p className="muted">入职欢迎需要在飞书应用的“事件与回调”中选择“使用长连接接收事件”，订阅“员工入职”。</p>
      {data.enabled && data.welcomeEnabled && <p>入职事件连接：{data.workerRunning === false ? '后台服务未启动，请联系管理员检查' : ({ connected: '已连接', connecting: '连接中', reconnecting: '重新连接中', failed: '连接失败，后台将重试', idle: '等待重试', not_started: '尚未启动，可刷新页面查看' } as Record<string, string>)[data.eventConnection] ?? '等待连接，可刷新页面查看'}</p>}
      {canEdit && <div className="row-actions"><button className="primary-button" type="submit" disabled={busy}>保存</button><button className="secondary-button" type="button" disabled={busy || !data.secretConfigured} onClick={test}>检查连接</button></div>}
      {canEdit && data.helloText && <div><p className="muted">首次全员问候：{data.helloText}</p><button className="secondary-button" type="button" disabled={busy || !data.enabled || !data.secretConfigured || data.workerRunning === false || data.helloSubmitted || data.jobs.some(j => j.kind === 'hello')} onClick={hello}>向全员打招呼一次</button></div>}
      <details><summary>最近发送记录</summary>{data.jobs.length ? <ul>{data.jobs.map(j => <li key={j.id}>{({ morning: '早安', welcome: '欢迎', hello: '全员问候' } as Record<string, string>)[j.kind] ?? j.kind} · {({ pending: '等待发送', sending: '发送处理中，请勿重复提交', done: '已提交飞书', failed: '发送未确认', cancelled: '已取消' } as Record<string, string>)[j.status] ?? j.status}{j.lastError ? `：${j.lastError}` : ''}</li>)}</ul> : <p>暂无发送记录</p>}</details>
    </>}
    {message && <p role="status" className="notice ok-notice">{message}</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
  </form>;
}
