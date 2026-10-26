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
    <main className="auth-page">
      <section className="auth-main">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">白</span>
          <span>小白全流程系统</span>
        </div>
        <form className="auth-form" onSubmit={submit}>
          <div>
            <h2>登录</h2>
            <p className="auth-sub">使用公司管理员为你开通的账号</p>
          </div>
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
            企业尚未开通系统？<button type="button" onClick={() => setApplying(true)}>申请开通公司</button>
          </div>
        </form>
        <div className="auth-foot">杭州酷得斯科技有限公司 开发</div>
      </section>

      <section className="auth-art" aria-label="系统介绍">
        <span className="auth-art-disc" aria-hidden="true" />
        <span className="auth-art-ring" aria-hidden="true" />
        <img className="auth-mascot" src={mascot} alt="小白" />
        <div className="auth-art-copy">
          <strong>从采购到结算，一步不落</strong>
          <span>流程 · 资料 · 财务 · 店铺运营</span>
        </div>
      </section>
      {applying && <CompanyApplyDialog onClose={() => setApplying(false)} />}
    </main>
  );
}
