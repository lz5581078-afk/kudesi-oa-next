import { FeishuBindingCard } from '../auth/FeishuLogin';
import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { SecretInput } from './system/SecretInput';

export function ChangePasswordPage() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (newPassword.length < 10) return setError('新密码至少 10 位');
    if (newPassword === oldPassword) return setError('新密码不能和当前密码相同');
    if (newPassword !== confirm) return setError('两次输入的新密码不一致');
    setBusy(true);
    try {
      await api('/auth/change-password', { body: { oldPassword, newPassword } });
      await refresh();
      navigate('/', { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : '修改失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <><FeishuBindingCard /><form className="card narrow-form" onSubmit={submit}>
      <h1>修改密码</h1>
      <label>
        当前密码
        <SecretInput value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      <label>
        新密码（至少 10 位）
        <SecretInput value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" required />
      </label>
      <label>
        再输入一次新密码
        <SecretInput value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        {confirm && newPassword !== confirm && <small className="field-error-text">两次输入的新密码不一致</small>}
      </label>
      {error && <div role="alert" className="notice error">{error}</div>}
      <div className="row-actions">
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? '保存中…' : '保存新密码'}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => navigate(-1)}>取消</button>
      </div>
    </form></>
  );
}
