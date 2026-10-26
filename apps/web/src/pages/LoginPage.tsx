import { FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import mascot from '../assets/xiaobai.jpg';
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
    <main className="login-screen">
      <div className="login-shell">
        <section className="login-visual" aria-label="全流程业务系统">
          <div className="login-brand">
            <span className="login-brand-symbol" aria-hidden="true"><i /><i /><i /><i /></span>
            <span>酷得斯</span>
          </div>
          <div className="login-visual-copy">
            <span className="login-visual-rule" aria-hidden="true" />
            <h1>全流程业务系统</h1>
            <p>让每一步，都清晰有序。</p>
          </div>
          <div className="login-visual-steps" aria-hidden="true"><i /><i /><i /><i /></div>
          <img className="login-mascot" src={mascot} alt="" />
        </section>

        <section className="login-access">
          <form className="login-form" onSubmit={submit}>
            <h2>账号登录</h2>
            <label>
              <span>登录账号</span>
              <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="请输入登录账号" autoComplete="username" autoFocus required />
            </label>
            <label>
              <span>登录密码</span>
              <div className="login-password">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  required
                />
                <button type="button" className="login-password-toggle" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
            </label>
            {error && <div role="alert" className="notice error">{error}</div>}
            <button type="submit" className="primary-button login-submit" disabled={busy || !account.trim() || !password}>
              {busy ? '正在登录…' : '登录'}
            </button>
            <div className="login-apply-entry">
              <span>企业尚未开通系统？</span>
              <button type="button" onClick={() => setApplying(true)}>申请开通公司</button>
            </div>
          </form>
          <footer className="login-provider">杭州酷得斯科技有限公司 开发</footer>
        </section>
      </div>
      {applying && <CompanyApplyDialog onClose={() => setApplying(false)} />}
    </main>
  );
}
