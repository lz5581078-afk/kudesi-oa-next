import { FormEvent, useState } from 'react';
import { useAuth } from '../auth/AuthContext';

const COMPANY_KEY = 'kudesi.companyCode';

export function LoginPage() {
  const { login } = useAuth();
  const [companyCode, setCompanyCode] = useState(() => localStorage.getItem(COMPANY_KEY) ?? '');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ companyCode: companyCode.trim(), account: account.trim(), password });
      localStorage.setItem(COMPANY_KEY, companyCode.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-screen">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand login-brand">
          <span className="brand-mark" aria-hidden="true">酷</span>
          <span>酷得斯 OA</span>
        </div>
        <label>
          公司代码
          <input value={companyCode} onChange={(e) => setCompanyCode(e.target.value)} autoComplete="organization" required />
        </label>
        <label>
          账号
          <input value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          密码
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <div role="alert" className="notice error">{error}</div>}
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  );
}
