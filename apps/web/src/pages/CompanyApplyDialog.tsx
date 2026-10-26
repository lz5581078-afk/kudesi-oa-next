import { FormEvent, useState } from 'react';
import { APPLY_PASSWORD_MIN, PHONE_PATTERN } from '@kudesi/shared';
import { api } from '../api/client';

const EMPTY = { companyName: '', contactName: '', contactPhone: '', password: '', contactTitle: '', remark: '' };

/** 登录页的“申请开通公司”：提交后等平台审核，通过后联系人手机号就是企业管理员账号。 */
export function CompanyApplyDialog({ onClose }: { onClose: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!PHONE_PATTERN.test(form.contactPhone.trim())) return setError('请输入 11 位手机号');
    if (form.password.length < APPLY_PASSWORD_MIN) return setError(`管理员密码至少 ${APPLY_PASSWORD_MIN} 位`);
    setError(null);
    setBusy(true);
    try {
      await api('/company-applications', {
        method: 'POST',
        body: {
          companyName: form.companyName.trim(),
          contactName: form.contactName.trim(),
          contactPhone: form.contactPhone.trim(),
          password: form.password,
          ...(form.contactTitle.trim() ? { contactTitle: form.contactTitle.trim() } : {}),
          ...(form.remark.trim() ? { remark: form.remark.trim() } : {}),
        },
      });
      setForm(EMPTY);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <form className="card modal" role="dialog" aria-modal="true" aria-label="申请开通公司" onSubmit={submit}>
        <div className="modal-head">
          <strong>申请开通公司</strong>
          <div className="muted-text">联系人手机号将作为企业管理员账号</div>
        </div>
        <div className="modal-body">
          {done ? (
            <div role="status" className="notice">申请已提交，审核通过后即可用手机号和刚设置的密码登录。</div>
          ) : (
            <>
              <label>公司名称<input value={form.companyName} onChange={set('companyName')} placeholder="请输入公司全称" maxLength={100} required /></label>
              <label>联系人<input value={form.contactName} onChange={set('contactName')} placeholder="请输入联系人姓名" maxLength={50} required /></label>
              <label>联系电话（管理员账号）<input value={form.contactPhone} onChange={set('contactPhone')} placeholder="请输入手机号" inputMode="tel" maxLength={11} required /></label>
              <label>管理员密码<input type="password" value={form.password} onChange={set('password')} placeholder={`至少 ${APPLY_PASSWORD_MIN} 位`} autoComplete="new-password" required /></label>
              <label>联系人职务<input value={form.contactTitle} onChange={set('contactTitle')} placeholder="负责人 / 行政等" maxLength={50} /></label>
              <label>申请说明<textarea value={form.remark} onChange={set('remark')} placeholder="可填写公司规模或开通需求" maxLength={500} rows={3} /></label>
              {error && <div role="alert" className="notice error">{error}</div>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button type="button" className="secondary-button" onClick={onClose}>{done ? '关闭' : '取消'}</button>
          {!done && <button type="submit" className="primary-button" disabled={busy}>{busy ? '正在提交…' : '提交申请'}</button>}
        </div>
      </form>
    </div>
  );
}
