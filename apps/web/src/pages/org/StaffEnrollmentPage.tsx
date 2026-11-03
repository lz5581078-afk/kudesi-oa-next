import { EMPLOYMENT_LABELS } from './orgApi';
import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { enrollmentApi, type EnrollmentPreview } from './enrollmentApi';
import './enrollment.css';

export function StaffEnrollmentPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const token = useLocation().hash.slice(1);
  const [info, setInfo] = useState<EnrollmentPreview | null>(null), [error, setError] = useState('');
  const [name, setName] = useState(''), [phone, setPhone] = useState(''), [password, setPassword] = useState(''), [position, setPosition] = useState('');
  const [busy, setBusy] = useState(false), [joined, setJoined] = useState<{ companyName: string; positionName: string; account: string } | null>(null);
  useEffect(() => {
    let active = true;
    setInfo(null); setJoined(null); setError(''); setName(''); setPhone(''); setPassword(''); setPosition('');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { setError('入职二维码无效，请联系人事重新获取。'); return; }
    enrollmentApi.preview(token).then(r => { if (active) setInfo(r); }).catch(e => { if (active) setError(e instanceof Error ? e.message : '二维码读取失败，请重试'); });
    return () => { active = false; };
  }, [token]);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (!info || busy) return;
    if (info.mode === 'general' && !position) { setError('请选择要加入的岗位'); return; }
    setBusy(true); setError('');
    const submittedPassword = password;
    try {
      const result = await enrollmentApi.join({ token, name: name.trim(), phone: phone.trim(), password: submittedPassword, ...(info.mode === 'general' ? { positionId: Number(position) } : {}) });
      setJoined(result); setPassword('');
      try { await login({ account: result.account, password: submittedPassword }); navigate('/', { replace: true }); }
      catch { setError('已成功加入公司，请使用手机号和刚设置的密码登录。'); }
    } catch (e) { setError(e instanceof Error ? e.message : '加入失败，请重试'); }
    finally { setBusy(false); }
  }
  return <main className="enrollment-page"><section className="enrollment-card">
    <span className="enrollment-brand">小白全流程系统</span>
    <h1>{joined ? '入职成功' : info ? `加入${info.companyName}` : '员工扫码入职'}</h1>
    {error && <div className={joined ? 'notice' : 'notice error'} role="alert">{error}</div>}
    {!info && !error && <p role="status" className="muted">正在读取入职信息…</p>}
    {joined ? <div><p>已加入 {joined.companyName} · {joined.positionName}</p><p>登录账号：{joined.account}</p><Link className="primary-button" to="/">前往登录</Link></div> : info && <>
      <p className="enrollment-intro">填写以下信息，完成入职并建立你的 OA 账号。</p>
      {info.mode === 'position' && <div className="enrollment-position">入职岗位<strong>{info.position?.name}</strong><span>入职后将引导你绑定本人企业飞书，接收 OA 通知。</span></div>}
      <p>用工类型：{EMPLOYMENT_LABELS[info.employmentType ?? 'regular']}</p>
      {info.employmentType && info.employmentType !== 'regular' && <p>{info.contractStartDate ? `合作期限：${info.contractStartDate} 至 ${info.contractEndDate || '不限期'}。` : '无需填写合作日期，开始日期按实际入职当天记录，结束日期留空。'}入职后自动建立兼职与临时工档案。</p>}
      <form onSubmit={e => void submit(e)} className="enrollment-form">
        <label>姓名<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} maxLength={50} required placeholder="请输入真实姓名" /></label>
        <label>手机号<input type="tel" inputMode="numeric" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} pattern="1[3-9][0-9]{9}" maxLength={11} required placeholder="手机号将作为登录账号" /></label>
        <label>登录密码<input type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} minLength={10} maxLength={64} required placeholder="设置至少10位的登录密码" /></label>
        {info.mode === 'general' && <label>选择岗位<select value={position} onChange={e => setPosition(e.target.value)} required><option value="">请选择入职岗位</option>{info.positions.map(p => <option key={p.id} value={p.id}>{p.departmentName ? `${p.departmentName} / ` : ''}{p.name}</option>)}</select></label>}
        {info.mode === 'general' && info.positions.length === 0 && <p className="notice">公司暂时没有可加入的岗位，请联系人事。</p>}
        <button type="submit" className="primary-button" disabled={busy || (info.mode === 'general' && !info.positions.length)}>{busy ? '正在加入…' : '加入公司并登录'}</button>
      </form>
    </>}
    {!joined && <p className="enrollment-login">已有账号？<Link to="/">直接登录</Link></p>}
  </section></main>;
}
