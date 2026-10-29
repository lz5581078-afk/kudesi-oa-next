import { useEffect, useRef, useState } from 'react';
import { api, tokenStore } from '../api/client';
import type { LoginResponse } from '@kudesi/shared';

export function FeishuLogin() {
  const [companies, setCompanies] = useState<Array<{ id: number; name: string }>>([]);
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    const query = new URLSearchParams(location.search), code = query.get('code'), state = query.get('state');
    if (code && state) {
      if (started.current) return; started.current = true;
      history.replaceState(null, '', location.pathname);
      setBusy(true);
      api<LoginResponse>('/auth/feishu/complete', { body: { code, state } }).then(r => { tokenStore.set(r.accessToken); location.replace('/'); }).catch(e => { setError(e.message); setBusy(false); });
    } else if (query.has('error')) { setError('飞书授权已取消，请重新尝试'); history.replaceState(null, '', location.pathname); }
    api<Array<{ id: number; name: string }>>('/auth/feishu/companies').then(rows => { setCompanies(rows); if (rows.length) setCompanyId(String(rows[0].id)); }).catch(() => {});
  }, []);
  async function begin() {
    setBusy(true); setError('');
    try { const r = await api<{ authorizationUrl: string }>('/auth/feishu/start', { body: { companyId: Number(companyId) } }); location.assign(r.authorizationUrl); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return <div className="stack">
    {companies.length > 1 && <label>飞书所属公司<select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    {companies.length > 0 && <button type="button" className="secondary-button" disabled={busy || !companyId} onClick={begin}>{busy ? '正在授权…' : '飞书授权登录'}</button>}
    {error && <div role="alert" className="notice error">{error}</div>}
  </div>;
}
export function FeishuBindingCard() {
  const [status, setStatus] = useState<{ bound: boolean } | null>(null), [error, setError] = useState('');
  useEffect(() => { api<{ bound: boolean }>('/auth/feishu/binding').then(setStatus).catch(() => {}); }, []);
  async function bind() {
    try { const r = await api<{ authorizationUrl: string }>('/auth/feishu/bind/start', { body: {} }); location.assign(r.authorizationUrl); } catch (e) { setError((e as Error).message); }
  }
  if (!status) return null;
  return <section className="card"><h2>飞书账号</h2><p>{status.bound ? '已绑定，可以使用飞书登录并接收流程通知。' : '绑定自己的企业飞书账号后，可以使用飞书登录并接收通知。'}</p>{!status.bound && <button type="button" className="secondary-button" onClick={bind}>绑定我的飞书</button>}{error && <p role="alert">{error}</p>}</section>;
}
export function FeishuBindCallback() {
  const started = useRef(false), [message, setMessage] = useState('正在验证飞书身份…');
  useEffect(() => {
    if (started.current) return; started.current = true;
    const q = new URLSearchParams(location.search), code = q.get('code'), state = q.get('state');
    history.replaceState(null, '', '/feishu-bind');
    if (!code || !state) { setMessage('授权不完整，请返回重新绑定'); return; }
    api('/auth/feishu/bind/complete', { body: { code, state } }).then(() => setMessage('飞书绑定成功')).catch(e => setMessage(e.message));
  }, []);
  return <div className="card"><p role="status">{message}</p><a href="/account/password">返回账号设置</a></div>;
}
