import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { resourceApi, type ResourceDto } from '../../resources/api';
import { money } from '../finance/common';

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const errText = (e: unknown) => (e instanceof ApiError ? e.message : '保存失败');
const label = (p: ResourceDto) => `${p.title}${p.data.carrier ? ` · ${String(p.data.carrier)}` : ''}`;

/**
 * 费用模块：集中维护手机号的子卡费用和宽带费用。
 * 这里不另存数据，保存时直接写回手机号档案（主卡、月费、充值周期）和宽带账号档案（金额、周期），
 * 变更记录留在各自档案的操作记录里。
 */
export function FeeSettingsPage() {
  const [phones, setPhones] = useState<ResourceDto[]>([]);
  const [broadband, setBroadband] = useState<ResourceDto[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [sub, setSub] = useState({ parentId: '', subId: '', fee: '', days: '30' });
  const [bb, setBb] = useState({ id: '', fee: '', cycle: 'monthly' });

  const load = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([resourceApi.list('phones', { pageSize: 200, showHidden: true }), resourceApi.list('broadband', { pageSize: 200, showHidden: true })]);
      setPhones(p.items);
      setBroadband(b.items);
    } catch (e) { setError(e instanceof ApiError ? e.message : '加载失败'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const byId = new Map(phones.map((p) => [p.id, p]));
  const subCards = phones.filter((p) => p.data.parentPhoneId);

  async function saveSub(e: FormEvent) {
    e.preventDefault();
    setError(''); setOk('');
    if (!sub.subId) return setError('请选择子卡号');
    if (sub.parentId && sub.parentId === sub.subId) return setError('子卡不能选择自己作为主卡');
    try {
      await resourceApi.update('phones', Number(sub.subId), {
        parentPhoneId: sub.parentId ? Number(sub.parentId) : null,
        monthlyFee: Math.round(Number(sub.fee || 0) * 100),
        rechargeCycleDays: Number(sub.days) || 30,
      });
      setOk('子卡费用已同步到手机号档案');
      await load();
    } catch (err) { setError(errText(err)); }
  }

  async function saveBb(e: FormEvent) {
    e.preventDefault();
    setError(''); setOk('');
    if (!bb.id) return setError('请选择宽带账号');
    try {
      await resourceApi.update('broadband', Number(bb.id), { amount: Math.round(Number(bb.fee || 0) * 100), cycle: bb.cycle });
      setOk('宽带费用已同步到宽带账号档案');
      await load();
    } catch (err) { setError(errText(err)); }
  }

  const pickSub = (p: ResourceDto) => setSub({ parentId: p.data.parentPhoneId ? String(p.data.parentPhoneId) : '', subId: String(p.id), fee: p.data.monthlyFee ? String(num(p.data.monthlyFee) / 100) : '', days: String(p.data.rechargeCycleDays || 30) });
  const pickBb = (b: ResourceDto) => setBb({ id: String(b.id), fee: b.data.amount ? String(num(b.data.amount) / 100) : '', cycle: String(b.data.cycle || 'monthly') });

  return (
    <section className="page">
      <h1>费用模块</h1>
      <p className="muted">集中维护手机号套餐、子卡费用和宽带费用；保存后直接写回手机号档案和宽带账号档案。</p>
      {error && <div role="alert" className="notice error">{error}</div>}
      {ok && <div role="status" className="notice ok-notice">{ok}</div>}

      <div className="card">
        <h2>套餐费</h2>
        <table className="data-table">
          <thead><tr><th>号码</th><th>主子卡</th><th>运营商</th><th>套餐</th><th className="num">费用</th><th /></tr></thead>
          <tbody>
            {phones.map((p) => (
              <tr key={p.id}>
                <td>{p.title}</td>
                <td>{p.data.parentPhoneId ? `子卡 / 主卡：${byId.get(Number(p.data.parentPhoneId))?.title ?? p.data.parentPhoneId}` : '主卡'}</td>
                <td>{String(p.data.carrier ?? '-')}</td><td>{String(p.data.plan ?? '-')}</td>
                <td className="num">{p.data.monthlyFee ? money(num(p.data.monthlyFee)) : '-'}</td>
                <td><button type="button" className="link-button" onClick={() => pickSub(p)}>维护费用</button></td>
              </tr>
            ))}
            {phones.length === 0 && <tr><td colSpan={6} className="muted">还没有手机号档案。</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>子卡费用</h2>
        <form className="form-grid compact" onSubmit={saveSub}>
          <label>主卡号
            <select value={sub.parentId} onChange={(e) => setSub({ ...sub, parentId: e.target.value })}>
              <option value="">不关联主卡</option>
              {phones.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
            </select>
          </label>
          <label>子卡号
            <select value={sub.subId} onChange={(e) => setSub({ ...sub, subId: e.target.value })}>
              <option value="">请选择子卡号</option>
              {phones.map((p) => <option key={p.id} value={p.id}>{label(p)}</option>)}
            </select>
          </label>
          <label>子卡费用（元）<input type="number" min="0" step="0.01" value={sub.fee} onChange={(e) => setSub({ ...sub, fee: e.target.value })} /></label>
          <label>充值周期（天）<input type="number" min="1" step="1" value={sub.days} onChange={(e) => setSub({ ...sub, days: e.target.value })} /></label>
          <div className="form-actions"><button className="primary-button">保存子卡费用</button></div>
        </form>
        <table className="data-table">
          <thead><tr><th>子卡号</th><th>主卡号</th><th>套餐</th><th className="num">子卡费用</th><th /></tr></thead>
          <tbody>
            {subCards.map((p) => (
              <tr key={p.id}><td>{p.title}</td><td>{byId.get(Number(p.data.parentPhoneId))?.title ?? '-'}</td><td>{String(p.data.plan ?? '-')}</td><td className="num">{p.data.monthlyFee ? money(num(p.data.monthlyFee)) : '-'}</td><td><button type="button" className="link-button" onClick={() => pickSub(p)}>编辑</button></td></tr>
            ))}
            {subCards.length === 0 && <tr><td colSpan={5} className="muted">还没有子卡。</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>宽带费用</h2>
        <form className="form-grid compact" onSubmit={saveBb}>
          <label>宽带账号
            <select value={bb.id} onChange={(e) => setBb({ ...bb, id: e.target.value })}>
              <option value="">请选择宽带账号</option>
              {broadband.map((b) => <option key={b.id} value={b.id}>{b.title}{b.refLabels.locationId ? ` · ${b.refLabels.locationId}` : ''}</option>)}
            </select>
          </label>
          <label>宽带费用（元）<input type="number" min="0" step="0.01" value={bb.fee} onChange={(e) => setBb({ ...bb, fee: e.target.value })} /></label>
          <label>费用周期
            <select value={bb.cycle} onChange={(e) => setBb({ ...bb, cycle: e.target.value })}>
              <option value="monthly">每月</option><option value="yearly">每年</option>
            </select>
          </label>
          <div className="form-actions"><button className="primary-button">保存宽带费用</button></div>
        </form>
        <table className="data-table">
          <thead><tr><th>宽带账号</th><th>宽带位置</th><th>绑定手机号</th><th className="num">费用</th><th>状态</th><th /></tr></thead>
          <tbody>
            {broadband.map((b) => (
              <tr key={b.id}>
                <td>{b.title}</td><td>{b.refLabels.locationId ?? '-'}</td><td>{b.refLabels.phoneId ?? '-'}</td>
                <td className="num">{b.data.amount ? `${money(num(b.data.amount))} / ${b.data.cycle === 'yearly' ? '年' : '月'}` : '-'}</td>
                <td>{b.status === 'normal' ? '正常' : b.status === 'suspended' ? '停机' : '注销'}</td>
                <td><button type="button" className="link-button" onClick={() => pickBb(b)}>编辑</button></td>
              </tr>
            ))}
            {broadband.length === 0 && <tr><td colSpan={6} className="muted">还没有宽带账号。</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
