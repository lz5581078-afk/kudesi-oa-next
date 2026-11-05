import './feishuBinding.css';
import { rememberLiveRoom, consumeLiveRoom, pendingLiveRoom, liveScanCompany } from './liveRoomIntent';
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
  const desktopAttempt = useRef<AbortController | null>(null);
  const [waitingForClient, setWaitingForClient] = useState(false);
  useEffect(() => () => desktopAttempt.current?.abort(), []);
  function cancelDesktop() {
    desktopAttempt.current?.abort();
    desktopAttempt.current = null;
    setWaitingForClient(false);
    setBusy(false);
  }
  async function authorizeDesktop(id: number, openClient: (url: string) => Promise<boolean>) {
    const attempt = new AbortController();
    desktopAttempt.current = attempt;
    setBusy(true);
    setError('');
    try {
      const { authorizationUrl, state } = await api<{ authorizationUrl: string; state: string }>('/auth/feishu/desktop/start', { body: { companyId: id } });
      if (attempt.signal.aborted) return;
      if (!await openClient(authorizationUrl)) throw new Error('未能打开本机飞书，请重试');
      if (attempt.signal.aborted) return;
      setWaitingForClient(true);
      const deadline = Date.now() + 3 * 60_000;
      while (!attempt.signal.aborted && Date.now() < deadline) {
        const { login } = await api<{ login: LoginResponse | null }>('/auth/feishu/desktop/poll', { body: { state } });
        if (attempt.signal.aborted) return;
        if (login) {
          tokenStore.set(login.accessToken);
          location.replace(consumeLiveRoom());
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      if (!attempt.signal.aborted) setError('飞书授权等待超时，请重新发起');
    } catch (e) {
      if (!attempt.signal.aborted) setError((e as Error).message.replace(/^Error invoking remote method .*?: Error: /, ''));
    } finally {
      if (desktopAttempt.current === attempt && !attempt.signal.aborted) cancelDesktop();
    }
  }
  useEffect(() => {
    const query = new URLSearchParams(location.search), code = query.get('code'), state = query.get('state');
    if (code && state) {
      if (started.current) return; started.current = true;
      history.replaceState(null, '', location.pathname);
      setBusy(true);
      api<LoginResponse>('/auth/feishu/complete', { body: { code, state } }).then(r => { tokenStore.set(r.accessToken); location.replace(consumeLiveRoom()); }).catch(e => { setError(e.message); setBusy(false); });
    } else if (query.has('error')) { setError('飞书授权已取消，请重新尝试'); history.replaceState(null, '', location.pathname); }
    let active = true;
    const scanCompany = !code && !state && !query.has('error') ? liveScanCompany() : null;
    api<Array<{ id: number; name: string }>>('/auth/feishu/companies').then(rows => {
      if (!active) return;
      setCompanies(rows);
      const scan = rows.find(c => c.id === scanCompany);
      if (rows.length) setCompanyId(String(scan?.id ?? rows[0].id));
      if (scan && !started.current) {
        started.current = true;
        rememberLiveRoom();
        void authorize(scan.id, () => active);
      }
    }).catch(() => {});
    return () => { active = false; };

  }, []);
  async function authorize(id: number, active = () => true) {
    rememberLiveRoom();
    setBusy(true); setError('');
    try { const r = await api<{ authorizationUrl: string }>('/auth/feishu/start', { body: { companyId: id } }); if (active()) feishuApi.redirect(r.authorizationUrl); }
    catch (e) { if (active()) { setError((e as Error).message); setBusy(false); } }
  }
  return <div className="stack">
    {companies.length > 1 && <label>飞书所属公司<select value={companyId} onChange={e => setCompanyId(e.target.value)}>{companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    {companies.length > 0 && <button type="button" className="secondary-button" disabled={busy || !companyId} onClick={() => {
      const desktop = (window as Window & { oaDesktop?: { openFeishuLogin?: (url: string) => Promise<boolean> } }).oaDesktop;
      const openClient = desktop?.openFeishuLogin;
      if (openClient) void authorizeDesktop(Number(companyId), openClient);
      else void authorize(Number(companyId));
    }}>{busy ? '正在授权…' : '飞书授权登录'}</button>}
    {waitingForClient && <div className="stack"><p role="status">请在本机飞书完成授权，OA 会自动登录。</p><button type="button" className="secondary-button" onClick={cancelDesktop}>取消等待</button></div>}
    {error && <div role="alert" className="notice error">{error}</div>}
  </div>;
}
export function FeishuBindingCard() {
  const { user, refresh } = useAuth();
  const [status, setStatus] = useState<{ bound: boolean } | null>(null), [error, setError] = useState(''), [busy,setBusy]=useState(false);
  useEffect(() => {
    let active=true;
    feishuApi.status().then(value=>{if(active)setStatus(value);}).catch(()=>{if(active)setError('暂时无法读取绑定状态，你仍可点击按钮前往绑定。');});
    return ()=>{active=false;};
  }, [user?.companyId,user?.id,user?.feishuBindingPending]);
  async function bind() {
    if(busy)return;
    setBusy(true);setError('');rememberLiveRoom();
    try {
      const current=await feishuApi.status().catch(()=>null);if(current)setStatus(current);
      if(current?.bound){await refresh();return;}
      const result=await feishuApi.start();feishuApi.redirect(result.authorizationUrl);
    } catch(e) {setError(e instanceof Error?e.message:'暂时无法连接飞书，请重试');}
    finally {setBusy(false);}
  }
  const bound=status?.bound===true;
  return <section className="card feishu-binding-card" aria-label="飞书账号绑定">
    <header><h2>飞书账号</h2><span className={`pill ${bound?'ok':'warn'}`}>{bound?'已绑定':status||user?.feishuBindingPending?'未绑定':'状态待确认'}</span></header>
    <p>{bound?'已绑定本人飞书，可以使用飞书登录并接收公司开启的 OA 通知。':'绑定自己的企业飞书账号后，可以使用飞书登录，并接收 OA 待办和通知。'}</p>
    {!bound&&<button type="button" className="primary-button" disabled={busy} onClick={()=>void bind()}>{busy?'正在连接飞书…':'绑定我的飞书'}</button>}
    {error&&<p role="alert" className="notice error">{error}</p>}
  </section>;
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
