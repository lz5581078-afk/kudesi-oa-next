import { rememberLiveRoom, consumeLiveRoom, pendingLiveRoom } from './liveRoomIntent';
import { useAuth } from './AuthContext';
import { feishuApi } from './feishuApi';
import { useNavigate } from 'react-router-dom';
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
      api<LoginResponse>('/auth/feishu/complete', { body: { code, state } }).then(r => { tokenStore.set(r.accessToken); location.replace(consumeLiveRoom()); }).catch(e => { setError(e.message); setBusy(false); });
    } else if (query.has('error')) { setError('飞书授权已取消，请重新尝试'); history.replaceState(null, '', location.pathname); }
    api<Array<{ id: number; name: string }>>('/auth/feishu/companies').then(rows => { setCompanies(rows); if (rows.length) setCompanyId(String(rows[0].id)); }).catch(() => {});
  }, []);
  async function begin() {
    rememberLiveRoom();
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
  const { user } = useAuth();
  const [status, setStatus] = useState<{ bound: boolean } | null>(null), [error, setError] = useState('');
  useEffect(() => { api<{ bound: boolean }>('/auth/feishu/binding').then(setStatus).catch(() => {}); }, []);
  async function bind() {
    try { const r = await api<{ authorizationUrl: string }>('/auth/feishu/bind/start', { body: {} }); location.assign(r.authorizationUrl); } catch (e) { setError((e as Error).message); }
  }
  if (!status) return null;
  return <section className="card"><h2>飞书账号</h2><p>{status.bound ? '已绑定，可以使用飞书登录并接收流程通知。' : '绑定自己的企业飞书账号后，可以使用飞书登录并接收通知。'}</p>{(!status.bound || user?.feishuBindingPending) && <button type="button" className="secondary-button" onClick={bind}>绑定我的飞书</button>}{error && <p role="alert">{error}</p>}</section>;
}
export function FeishuBindCallback() {
  const { refresh, user, logout } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false), [message, setMessage] = useState('正在验证飞书身份…');
  const [bound, setBound] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    const q = new URLSearchParams(location.search), code = q.get('code'), state = q.get('state');
    history.replaceState(null, '', '/feishu-bind');
    if (!code || !state) { setMessage(q.has('error') ? '飞书授权已取消。必须完成绑定后才能进入 OA，请重新绑定。' : '授权不完整，请重新绑定后进入 OA'); return; }
    let completed = false;
    setBusy(true);
    feishuApi.complete(code, state).then(async () => {
      completed = true; setBound(true);
      await refresh();
      const status = await feishuApi.status();
      if (!status.bound) { setBound(false); setMessage('尚未完成本人企业飞书绑定，请重新绑定。'); return; }
      if (status.notificationsEnabled) { navigate(consumeLiveRoom(), { replace: true }); return; }
      setMessage('飞书绑定成功。公司通知开关尚未开启，开启后新 OA 通知将推送到你的飞书。');
    }).catch(e => setMessage(completed ? '飞书已绑定，状态暂未刷新，请刷新绑定状态后进入 OA。' : `未完成飞书绑定：${e.message}。请重试，绑定完成后才能进入 OA。`)).finally(() => setBusy(false));
  }, []);
  async function retry() {
    setBusy(true);
    try {
      if (bound) { await refresh(); navigate(consumeLiveRoom(), { replace: true }); }
      else { const result = await feishuApi.start(); feishuApi.redirect(result.authorizationUrl); }
    } catch (e) { setMessage(e instanceof Error ? e.message : '暂时无法完成绑定，请重试'); }
    finally { setBusy(false); }
  }
  const ready = bound || !user?.feishuBindingPending;
  return <main className="enrollment-page"><section className="enrollment-card">
    <h1>{bound ? '飞书绑定成功' : '完成飞书绑定'}</h1>
    <p role="status">{message}</p>
    <div className="enrollment-form">
      {ready && <a className="primary-button" href={pendingLiveRoom()}>进入 OA</a>}
      <button className="secondary-button" type="button" disabled={busy} onClick={() => void retry()}>{bound ? '刷新绑定状态' : '重新绑定飞书'}</button>
      <button className="secondary-button" type="button" onClick={logout}>退出登录</button>
    </div>
  </section></main>;
}
