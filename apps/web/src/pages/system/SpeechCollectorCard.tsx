import { FormEvent, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SecretInput } from './SecretInput';
type Speech = { configured: boolean; enabled: boolean; fileEnabled: boolean; realtimeEnabled: boolean; maxConcurrent: number };
export function SpeechCollectorCard({ canEdit }: { canEdit: boolean }) {
  const [saved, setSaved] = useState<Speech | null>(null);
  const [form, setForm] = useState({ enabled: false, fileEnabled: true, realtimeEnabled: true, maxConcurrent: 20, apiKey: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [success, setSuccess] = useState('');
  useEffect(() => { let alive = true; api<Speech>('/settings/integrations/speech').then(data => {
    if (alive) { setSaved(data); setForm({ enabled: data.enabled, fileEnabled: data.fileEnabled, realtimeEnabled: data.realtimeEnabled, maxConcurrent: data.maxConcurrent, apiKey: '' }); }
  }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  const dirty = Boolean(saved) && (Boolean(form.apiKey) || ['enabled', 'fileEnabled', 'realtimeEnabled', 'maxConcurrent'].some(key => form[key as keyof typeof form] !== saved![key as keyof Speech]));
  async function save(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(''); setSuccess('');
    try { const data = await api<Speech>('/settings/integrations/speech', { method: 'PUT', body: { ...form, apiKey: form.apiKey || undefined } });
      setSaved(data); setForm(f => ({ ...f, apiKey: '' })); setSuccess('已保存，Windows 采集器登录后自动使用公司配置。');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <form className="card settings-card" onSubmit={save} aria-label="小白抖音采集器语音识别">
    <div className="between"><h2 className="section-title">小白抖音采集器 · 语音识别</h2><span className={`pill ${saved?.enabled && saved.configured ? 'ok' : 'warn'}`}>{saved?.enabled && saved.configured ? '已启用' : '未启用'}</span></div>
    <p className="muted">员工用 OA 账号登录 Windows 软件。本机保存录像；选择豆包模式后，声音经 OA 转发识别，费用由公司的火山引擎账户承担。API Key 只在服务器加密保存。</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    {saved && <>
      <label>豆包语音 API Key<SecretInput value={form.apiKey} onChange={e => setForm({ ...form, apiKey: e.target.value })} disabled={!canEdit || busy} placeholder={saved.configured ? '已设置，留空保留原密钥' : '在火山引擎语音控制台创建'} /></label>
      <p className="muted">请开通录音文件极速版及流式语音识别 2.0。<a href="https://console.volcengine.com/speech/app" target="_blank" rel="noreferrer">打开语音控制台</a></p>
      {([['enabled', '启用公司云端语音识别'], ['fileEnabled', '允许分段识别：录好一段再转文字'], ['realtimeEnabled', '允许实时识别：边录边显示文字']] as const).map(([key, title]) => <label className="check" key={key}><input type="checkbox" checked={form[key]} onChange={e => setForm({ ...form, [key]: e.target.checked })} disabled={!canEdit || busy} style={{ width: 'auto', height: 'auto' }} />{title}</label>)}
      <label>公司语音调用并发上限（1–20，共享额度）<input type="number" min={1} max={20} value={form.maxConcurrent} onChange={e => setForm({ ...form, maxConcurrent: Number(e.target.value) })} disabled={!canEdit || busy} /></label>
      <p className="muted">员工还需在“员工与权限”中获授“小白抖音采集器”权限。可随时关闭云端调用；录像仍保存在电脑上。</p>
      {success && <div className="notice ok-notice" role="status">{success}</div>}
      {canEdit && <div className="row-actions"><button className="primary-button" disabled={busy || !dirty}>{busy ? '保存中…' : '保存语音设置'}</button>{dirty && <span className="muted">有未保存的修改</span>}</div>}
    </>}
  </form>;
}
