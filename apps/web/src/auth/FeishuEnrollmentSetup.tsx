import { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { feishuApi } from './feishuApi';
import '../pages/org/enrollment.css';

export function FeishuEnrollmentSetup() {
  const { user, refresh, logout } = useAuth();
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const mounted = useRef(true);
  async function begin(active: () => boolean) {
    setBusy(true); setError('');
    try {
      const status = await feishuApi.status();
      if (!active()) return;
      if (status.bound) { await refresh(); return; }
      const result = await feishuApi.start();
      if (active()) feishuApi.redirect(result.authorizationUrl);
    } catch (e) { if (active()) { setError(e instanceof Error ? e.message : '暂时无法连接飞书，请重试'); setBusy(false); } }
  }
  useEffect(() => {
    let active = true; mounted.current = true;
    void begin(() => active);
    return () => { active = false; mounted.current = false; };
  }, []);
  return <main className="enrollment-page"><section className="enrollment-card">
    <span className="enrollment-brand">{user?.companyName ?? '小白全流程系统'}</span>
    <h1>请先绑定本人飞书</h1>
    <p className="enrollment-intro">登录 OA 必须绑定本人企业飞书账号。完成身份确认后，才能进入系统使用业务功能。</p>
    {busy && <p role="status">正在前往飞书授权…</p>}
    {error && <div role="alert" className="notice error">{error}<p>尚未完成绑定，暂不能进入 OA。请重试或联系公司管理员检查飞书配置。</p></div>}
    <div className="enrollment-form">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void begin(() => mounted.current)}>继续绑定飞书</button>
      <button type="button" className="secondary-button" onClick={logout}>退出登录</button>
    </div>
    <p className="enrollment-login">手机和电脑均可完成绑定。公司开启飞书通知后，你收到的新 OA 通知将推送到本人飞书。</p>
  </section></main>;
}
