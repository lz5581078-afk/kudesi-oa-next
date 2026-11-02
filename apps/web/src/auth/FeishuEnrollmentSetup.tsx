import { useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { feishuApi } from './feishuApi';
import '../pages/org/enrollment.css';

export function FeishuEnrollmentSetup({ onLater }: { onLater: () => void }) {
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(true), [error, setError] = useState('');
  const mounted = useRef(true);
  async function begin(active: () => boolean) {
    setBusy(true); setError('');
    try {
      const status = await feishuApi.status();
      if (!active()) return;
      if (status.bound && status.allNotificationsEnabled) { await refresh(); return; }
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
    <h1>绑定飞书，接收入职后的通知</h1>
    <p className="enrollment-intro">OA 账号已建立。下一步使用你本人的企业飞书账号确认身份，系统会将两个账号绑定。</p>
    {busy && <p role="status">正在前往飞书授权…</p>}
    {error && <div role="alert" className="notice error">{error}<p>OA 账号已经保留，无需重新入职。可重试或联系公司管理员检查飞书配置。</p></div>}
    <div className="enrollment-form">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void begin(() => mounted.current)}>继续绑定飞书</button>
      <button type="button" className="secondary-button" onClick={onLater}>稍后绑定，先进入 OA</button>
    </div>
    <p className="enrollment-login">绑定后，公司开启飞书通知时，你收到的新 OA 通知将推送到本人飞书。</p>
  </section></main>;
}
