import { FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { CompanyApplyDialog } from './CompanyApplyDialog';

export function LoginPage() {
  const { login } = useAuth();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await login({ account: account.trim(), password });
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败，请检查账号和密码。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-aside" aria-label="系统介绍">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">酷</span>
          <span>酷得斯 OA</span>
        </div>
        <div>
          <h1>一套系统，管住从采购到结算的每一步</h1>
          <p>流程、资料、财务和店铺运营放在同一个地方，谁能看什么、谁来批什么，都按岗位清清楚楚。</p>
          <ul className="auth-points">
            <li><span><strong>统一流程</strong>　申请、审批、待办，一处办理</span></li>
            <li><span><strong>按岗位授权</strong>　成本、价格等敏感信息只给该看的人</span></li>
            <li><span><strong>财务成本</strong>　商品成本、快递运费、利润一张表算清</span></li>
          </ul>
        </div>
        <small>杭州酷得斯科技有限公司 开发</small>
      </section>

      <section className="auth-main">
        <form className="card auth-card" onSubmit={submit}>
          <h2>登录</h2>
          <label>
            登录账号
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="请输入登录账号" autoComplete="username" autoFocus required />
          </label>
          <label>
            登录密码
            <span className="auth-password">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                autoComplete="current-password"
                required
              />
              <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                {showPassword ? '隐藏' : '显示'}
              </button>
            </span>
          </label>
          {error && <div role="alert" className="notice error">{error}</div>}
          <button type="submit" className="primary-button" disabled={busy || !account.trim() || !password}>
            {busy ? '正在登录…' : '登录'}
          </button>
          <div className="auth-apply">
            <span>企业尚未开通系统？</span>
            <button type="button" onClick={() => setApplying(true)}>申请开通公司</button>
          </div>
        </form>
      </section>
      {applying && <CompanyApplyDialog onClose={() => setApplying(false)} />}
    </main>
  );
}
